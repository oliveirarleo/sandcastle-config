// Three-phase orchestration loop:
//   1. Plan — analyze open issues, output unblocked work as a <plan> JSON.
//   2. Execute — run implementer + reviewer sandboxes concurrently.
//   3. Merge  — merge completed branches one at a time.
// Repeats up to MAX_ITERATIONS so newly unblocked issues are picked up after each merge round.

import * as sandcastle from "@ai-hero/sandcastle";
import pino from "pino";
import {
	copyToWorktree,
	hooks,
	MAX_ITERATIONS,
	MAX_PARALLEL_TASKS,
	POLL_INTERVAL_MS,
	sandboxProvider,
} from "./config.mts";

import { waitForOpenIssues } from "./helpers/issues.mts";
import { runExecutionPhase } from "./phases/execute.mts";
import { runMergePhase } from "./phases/merge.mts";
import { runPlanner } from "./phases/plan.mts";
import type { PlannerIssue } from "./types.mts";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({
	level: process.env.LOG_LEVEL ?? "info",
	transport:
		process.env.NODE_ENV !== "production"
			? { target: "pino-pretty", options: { colorize: true } }
			: undefined,
});

// ---------------------------------------------------------------------------
// Process-level safety net
// ---------------------------------------------------------------------------
// Catches stray unhandled rejections (e.g. Effect defects from orDie /
// uncaught Effect.runPromise) that would otherwise crash the process.
process.on("unhandledRejection", (reason) => {
	logger.error({ err: reason }, "Unhandled promise rejection caught by safety net");
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
	// -----------------------------------------------------------------------
	// Poll for open issues
	// -----------------------------------------------------------------------
	logger.debug("About to call waitForOpenIssues...");
	const openIssues = await waitForOpenIssues(POLL_INTERVAL_MS, logger);
	logger.debug("waitForOpenIssues returned.");
	logger.info(
		{ count: openIssues.length, iteration, maxIterations: MAX_ITERATIONS },
		"Starting planner",
	);

	// -------------------------------------------------------------------------
	// Phase 1: Plan
	// -------------------------------------------------------------------------
	let issues: PlannerIssue[];
	try {
		issues = await runPlanner(sandcastle.run, sandboxProvider, hooks, logger);
	} catch (err) {
		logger.error({ err }, "Phase 1 (plan) failed — exiting loop");
		break;
	}

	if (issues.length === 0) {
		// No unblocked work — either everything is done or everything is blocked.
		logger.info("No unblocked issues to work on. Exiting.");
		break;
	}

	// -------------------------------------------------------------------------
	// Phase 2: Execute + Review
	// -------------------------------------------------------------------------

	let completedIssues: PlannerIssue[];
	try {
		completedIssues = await runExecutionPhase(
			issues,
			sandcastle.createSandbox,
			sandboxProvider,
			hooks,
			copyToWorktree,
			MAX_PARALLEL_TASKS,
			logger,
		);
	} catch (err) {
		logger.error({ err }, "Phase 2 (execute) failed — skipping merge, continuing loop");
		continue;
	}

	const completedBranches = completedIssues.map((i) => i.branch);

	logger.info({ count: completedBranches.length }, "Execution complete");
	for (const branch of completedBranches) {
		logger.info(`  ${branch}`);
	}

	if (completedBranches.length === 0) {
		// All agents ran but none made commits — nothing to merge this cycle.
		logger.info("No commits produced. Nothing to merge.");
		continue;
	}

	// ---------------------------------------------------------------------
	// Phase 3: Merge
	//
	// Merge each completed branch into the current branch one at a time.
	// Per-branch error isolation is handled inside runMergePhase (one
	// failing merge does not block remaining branches). If the entire
	// merge phase throws (e.g. sandbox provider failure), log and continue.
	// ---------------------------------------------------------------------
	try {
		await runMergePhase(sandcastle.run, completedIssues, sandboxProvider, hooks, logger);
	} catch (err) {
		logger.error({ err }, "Phase 3 (merge) failed — continuing loop");
		continue;
	}

	logger.info("Branches merged.");
}
