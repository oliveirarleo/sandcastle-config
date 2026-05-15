// Sandcastle daemon — four-phase poll loop (Plan → Execute → Merge).
// Runs indefinitely; SIGTERM triggers graceful shutdown after current iteration.
// Includes label state machine for crash-revert and resume routing.

import * as sandcastle from "@ai-hero/sandcastle";
import { $ } from "zx";
import {
	copyToWorktree,
	GRACEFUL_SHUTDOWN_MS,
	hooks,
	logger,
	MAX_PARALLEL_TASKS,
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
import { createNotifierFromEnv, formatErrorMessage } from "./helpers/notifier.mts";
import { type ExecuteLabelCallbacks, runExecutionPhase } from "./phases/execute.mts";
import { runMergePhase } from "./phases/merge.mts";
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
): Promise<{ execute: PlannerIssue[]; merge: PlannerIssue[] }> {
	const execute: PlannerIssue[] = [];
	const merge: PlannerIssue[] = [];

	for (const issue of openIssues) {
		const routing = classifyResumeLabel(issue);

		if (routing === "skip") continue;

		// Load persisted metadata for resume sessions and branch name
		const implementSession = await getMetadata(issue.id, "implementSession");
		const reviewSession = await getMetadata(issue.id, "reviewSession");
		const branch = (await getMetadata(issue.id, "sandcastleBranch")) ?? `sandcastle/${issue.id}`;

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

	return { execute, merge };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const notifier = createNotifierFromEnv();
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

	// Merge completion callback: label as merged and close the bead issue
	const onMergeComplete = async (issueId: string): Promise<void> => {
		await addLabel(issueId, MERGED);
		await $`sh -c ${`bd close "${issueId}"`}`.quiet();
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

		if (shouldSkipPlanner(openIssues)) {
			// Resume mode: route issues based on current labels instead of planning
			const routed = await routeResumeIssues(openIssues);
			issues = routed.execute;
			resumeMerge = routed.merge;
			logger.info(
				{ executeCount: issues.length, mergeCount: resumeMerge.length },
				"Resume routing complete",
			);
		} else {
			try {
				issues = await runPlanner(sandcastle.run, sandboxProvider, hooks, logger, onPlanComplete);
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
		// Phase 2: Execute + Review
		// ---------------------------------------------------------------------------
		let completed: PlannerIssue[] = [];

		if (issues.length > 0) {
			try {
				completed = await runExecutionPhase(
					issues,
					sandcastle.createSandbox,
					sandboxProvider,
					hooks,
					copyToWorktree,
					MAX_PARALLEL_TASKS,
					logger,
					labelCallbacks,
					notifier,
				);
			} catch (err) {
				logger.error({ err }, "Execute phase failed — continuing");
				continue;
			}

			const branches = completed.map((i) => i.branch);
			logger.info({ count: branches.length }, "Execution complete");
			for (const b of branches) logger.info(`  ${b}`);
		}

		// ---------------------------------------------------------------------------
		// Phase 3: Merge
		// ---------------------------------------------------------------------------
		// Merge both freshly-executed issues and issues routed straight to merge
		const allToMerge = [...completed, ...resumeMerge];
		if (allToMerge.length === 0) {
			logger.info("No commits produced or issues to merge. Skipping merge.");
			if (!shouldSkipPlanner(openIssues)) {
				break;
			}
			continue;
		}

		try {
			await runMergePhase(
				sandcastle.run,
				allToMerge,
				sandboxProvider,
				hooks,
				logger,
				onMergeComplete,
			);
		} catch (err) {
			logger.error({ err }, "Merge phase failed — continuing");
			notifier
				?.send({
					level: "error",
					title: "Merge phase failed",
					message: `Merge phase failed: ${formatErrorMessage(err)}`,
					tags: ["merge", "sandcastle", "error"],
				})
				.catch(() => {});
			continue;
		}

		logger.info({ count: allToMerge.length }, "Branches merged.");

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
