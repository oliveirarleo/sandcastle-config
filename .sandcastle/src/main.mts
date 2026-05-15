// Sandcastle daemon — four-phase poll loop (Plan → Execute → Merge).
// Runs indefinitely; SIGTERM triggers graceful shutdown after current iteration.
// Includes label state machine for crash-revert and resume routing.

import * as sandcastle from "@ai-hero/sandcastle";
import {
	copyToWorktree,
	GRACEFUL_SHUTDOWN_MS,
	hooks,
	logger,
	MAX_PARALLEL_TASKS,
	notifier,
	phaseHooks,
	POLL_INTERVAL_MS,
	sandboxProvider,
} from "./config.mts";
import { waitForOpenIssues } from "./helpers/issues.mts";
import {
	addLabel,
	classifyResumeLabel,
	EXECUTED,
	EXECUTING,
	getMetadata,
	MERGED,
	PLANNED,
	REVIEWING,
	revertPhaseLabel,
	setMetadata,
	shouldSkipPlanner,
} from "./helpers/labels.mts";
import { formatErrorMessage } from "./helpers/notifier.mts";
import { createExecuteOneIssue, type ExecuteLabelCallbacks } from "./phases/execute.mts";
import { runMergePhase, verifyMergedIssues } from "./phases/merge.mts";
import { runPipeline } from "./phases/pipeline.mts";
import { runPlanner } from "./phases/plan.mts";
import type { BeadsIssue, PlannerIssue } from "./types.mts";

// ---------------------------------------------------------------------------
// Label callbacks factory
// ---------------------------------------------------------------------------

/**
 * Create the label callbacks for the execute phase.
 *
 * Each callback persists the current phase as a sandcastle:* label on the
 * bead issue so the pipeline can resume after a crash or restart.
 */
export function createLabelCallbacks(deps?: {
	exec?: (cmd: string) => Promise<string>;
}): ExecuteLabelCallbacks {
	return {
		onImplementStart: async (issueId: string) => {
			await addLabel(issueId, EXECUTING, deps);
		},
		onReviewStart: async (issueId: string) => {
			await addLabel(issueId, REVIEWING, deps);
		},
		onExecuteComplete: async (issueId: string) => {
			await addLabel(issueId, EXECUTED, deps);
		},
		onImplementSession: async (issueId: string, sessionId?: string) => {
			if (sessionId) {
				await setMetadata(issueId, "implementSession", sessionId, deps);
			}
		},
		onReviewSession: async (issueId: string, sessionId?: string) => {
			if (sessionId) {
				await setMetadata(issueId, "reviewSession", sessionId, deps);
			}
		},
		onValidateSession: async (_sessionId: string) => {
			// sandcastle.run() validates session file existence internally.
			// This pre-check always returns true — stale sessions are caught
			// via crash revert.
			return true;
		},
		onCrash: async (issueId: string, currentLabel: string) => {
			await revertPhaseLabel(issueId, currentLabel, deps);
		},
	};
}

// ---------------------------------------------------------------------------
// Resume routing
// ---------------------------------------------------------------------------

/**
 * Route open issues through the appropriate phases based on their current
 * sandcastle labels, skipping the planner entirely.
 *
 * Returns the issues that should go through execution and merge phases.
 */
async function routeResumeIssues(
	openIssues: BeadsIssue[],
): Promise<{ execute: PlannerIssue[]; merge: PlannerIssue[]; merged: PlannerIssue[] }> {
	const execute: PlannerIssue[] = [];
	const merge: PlannerIssue[] = [];
	const merged: PlannerIssue[] = [];

	for (const issue of openIssues) {
		const routing = classifyResumeLabel(issue);
		const branch = (await getMetadata(issue.id, "sandcastleBranch")) ?? `sandcastle/${issue.id}`;

		if (routing === "skip") {
			// Issues labeled merged need safety-net verification
			if (issue.labels.includes(MERGED)) {
				merged.push({
					id: issue.id,
					title: issue.title,
					branch,
					skipImplementer: true,
				});
			}
			continue;
		}

		// Load persisted metadata for resume sessions
		const implementSession = await getMetadata(issue.id, "implementSession");
		const reviewSession = await getMetadata(issue.id, "reviewSession");

		const labels = new Set(issue.labels);

		if (routing === "execute") {
			// REVIEWING -> skip implementer; EXECUTING -> resume implementer; PLANNED -> fresh
			const isReviewing = labels.has(REVIEWING);
			const isExecuting = labels.has(EXECUTING);

			execute.push({
				id: issue.id,
				title: issue.title,
				branch,
				implementSession: isExecuting ? implementSession : undefined,
				reviewSession: isReviewing ? reviewSession : undefined,
				skipImplementer: isReviewing,
			});
		} else {
			// "merge" — already executed, go straight to merge phase
			merge.push({
				id: issue.id,
				title: issue.title,
				branch,
				skipImplementer: true,
			});
		}
	}

	return { execute, merge, merged };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

logger.info(
	notifier
		? "Notifier enabled via NTFY_TOPIC_URL"
		: "Notifier disabled — set NTFY_TOPIC_URL to enable ntfy.sh notifications",
);

export async function main(): Promise<void> {
	process.on("unhandledRejection", (reason) =>
		logger.error({ err: reason }, "Unhandled rejection — caught by safety net"),
	);

	let shouldShutdown = false;
	process.on("SIGTERM", () => {
		logger.info("SIGTERM received — will shut down after current iteration");
		shouldShutdown = true;
		setTimeout(() => {
			logger.fatal("Graceful shutdown timeout — forcing exit");
			process.exit(1);
		}, GRACEFUL_SHUTDOWN_MS).unref();
	});

	// Create label callbacks once (shared across iterations)
	const labelCallbacks = createLabelCallbacks();

	// Plan completion callback: label each issue as planned and persist branch
	const onPlanComplete = async (plannedIssues: PlannerIssue[]): Promise<void> => {
		for (const pi of plannedIssues) {
			await addLabel(pi.id, PLANNED);
			await setMetadata(pi.id, "sandcastleBranch", pi.branch);
		}
	};

		let iteration = 0;
	while (true) {
		iteration++;
		logger.info({ iteration }, "Heartbeat — starting iteration");

		const openIssues = await waitForOpenIssues(POLL_INTERVAL_MS, logger);
		logger.info({ count: openIssues.length, iteration }, "Poll complete");

		// ---------------------------------------------------------------------------
		// Phase 1: Plan (or skip when resuming)
		// ---------------------------------------------------------------------------
		let issues: PlannerIssue[] = [];
		let resumeMerge: PlannerIssue[] = [];
		let mergedIssues: PlannerIssue[] = [];

		if (shouldSkipPlanner(openIssues)) {
			// Resume mode: route issues based on current labels instead of planning
			const routed = await routeResumeIssues(openIssues);
			issues = routed.execute;
			resumeMerge = routed.merge;
			mergedIssues = routed.merged;

			logger.info(
				{ executeCount: issues.length, mergeCount: resumeMerge.length, mergedCount: mergedIssues.length },
				"Resume routing complete",
			);
		} else {
			try {
				issues = await runPlanner(sandcastle.run, sandboxProvider, hooks, logger, onPlanComplete, phaseHooks);
			} catch (err) {
				logger.error({ err }, "Plan phase failed — exiting");
				notifier
					?.send({
						level: "error",
						title: "Plan phase failed",
						message: `Planning phase failed: ${formatErrorMessage(err)}`,
						tags: ["plan", "sandcastle", "error"],
					})
					.catch(() => {});
				break;
			}

			if (issues.length === 0) {
				logger.info("No unblocked issues — exiting");
				break;
			}
		}

		// ---------------------------------------------------------------------------
		// Phase 2 + 3: Execute → Merge pipeline (Effect.ts Queue)
		// ---------------------------------------------------------------------------
		// Safety net for merged-labeled issues: these are verified in the pipeline.
		// For resume mode, reverted issues get added back to the merge queue.
		if (mergedIssues.length > 0) {
			logger.info({ count: mergedIssues.length }, "Safety net: verifying merged-labeled issues in pipeline");
		}

		// Creator functions for the pipeline
		const executeOne = createExecuteOneIssue({
			createSandbox: sandcastle.createSandbox,
			sandboxProvider,
			sandboxHooks: hooks,
			copyToWorktree,
			logger,
			labelCallbacks,
			phaseHooks,
		});

		const mergeOne = async (issue: PlannerIssue): Promise<void> => {
			await runMergePhase(
				sandcastle.run,
				[issue],
				sandboxProvider,
				hooks,
				logger,
				phaseHooks,
			);
		};

		const verifyOne = async (issue: PlannerIssue): Promise<void> => {
			await verifyMergedIssues([issue], { logger });
		};

		const hasAnyIssues =
			issues.length > 0 || resumeMerge.length > 0 || mergedIssues.length > 0;

		if (hasAnyIssues) {
			try {
				await runPipeline({
					executeIssues: issues,
					mergeIssues: resumeMerge,
					mergedIssues,
					executeOne,
					mergeOne,
					verifyOne,
					maxParallelTasks: MAX_PARALLEL_TASKS,
					logger,
				});
			} catch (err) {
				logger.error({ err }, "Pipeline failed — continuing");
				notifier
					?.send({
						level: "error",
						title: "Pipeline failed",
						message: `Pipeline execution failed: ${formatErrorMessage(err)}`,
						tags: ["sandcastle", "error"],
					})
					.catch(() => {});
				continue;
			}

			logger.info("Pipeline complete.");
		} else {
			logger.info("No issues to process. Skipping.");
			if (!shouldSkipPlanner(openIssues)) {
				break;
			}
			continue;
		}

		if (shouldShutdown) {
			logger.info("Graceful shutdown — iteration complete");
			break;
		}
	}
}

// Only auto-run main() when executed directly, not when imported for tests
if (process.env.VITEST === undefined) {
	main().catch((err) => {
		logger.fatal({ err }, "Fatal error — exiting");
		process.exit(1);
	});
}
