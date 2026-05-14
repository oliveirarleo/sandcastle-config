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
  sandboxProvider,
  MAX_ITERATIONS,
  MAX_PARALLEL_TASKS,
  POLL_INTERVAL_MS,
  hooks,
  copyToWorktree,
} from "./config.mts";
import { runWithConcurrencyLimit } from "./helpers/concurrency.mts";
import { waitForOpenIssues } from "./helpers/issues.mts";
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
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await runWithConcurrencyLimit(
    issues,
    MAX_PARALLEL_TASKS,
    async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: sandboxProvider,
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.pi("opencode-go/kimi-k2.6"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // Only review if the implementer produced commits
        if (implement.commits.length > 0) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: sandcastle.pi("opencode-go/kimi-k2.6"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
            },
          });

          // Merge commits from both runs so the merge phase sees all of them.
          // Each sandbox.run() only returns commits from its own run.
          return {
            ...review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        return implement;
      } finally {
        await sandbox.close();
      }
    },
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      const issue = issues[i];
      if (issue) {
        logger.error({ err: outcome.reason }, `✗ ${issue.id} (${issue.branch}) failed`);
      }
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled.flatMap((outcome, i) => {
    const issue = issues[i];
    if (outcome.status === "fulfilled" && outcome.value.commits.length > 0 && issue) {
      return [issue];
    }
    return [];
  });

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
