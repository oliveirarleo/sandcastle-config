// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.

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
	const issues = await runPlanner(
		sandcastle.run,
		sandboxProvider,
		hooks,
		logger,
	);

	if (issues.length === 0) {
		// No unblocked work — either everything is done or everything is blocked.
		logger.info("No unblocked issues to work on. Exiting.");
		break;
	}

	// -------------------------------------------------------------------------
	// Phase 2: Execute + Review
	// -------------------------------------------------------------------------

	const completedIssues = await runExecutionPhase(
		issues,
		sandcastle.createSandbox,
		sandboxProvider,
		hooks,
		copyToWorktree,
		MAX_PARALLEL_TASKS,
		logger,
	);

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
	// This isolates failures: if one merge conflicts or fails tests, the
	// process stops there instead of leaving the repo in an ambiguous
	// partially-merged state.
	// ---------------------------------------------------------------------
	await runMergePhase(
		sandcastle.run,
		completedIssues,
		sandboxProvider,
		hooks,
		logger,
	);

	logger.info("Branches merged.");
}
