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
import { PlannerOutputSchema } from "./types.mts";
import { waitForOpenIssues } from "./helpers/issues.mts";
import { runExecutionPhase } from "./phases/execute.mts";
import { runMergePhase } from "./phases/merge.mts";

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
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  // -------------------------------------------------------------------------
  logger.debug("About to start planner sandcastle.run...");
  const plan = await sandcastle.run({
    hooks,
    sandbox: sandboxProvider,
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code.
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.pi("opencode-go/deepseek-v4-pro"),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  logger.debug("Planner sandcastle.run returned.");
  // Extract the <plan>…</plan> block from the agent's stdout.
  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  // The plan JSON contains an array of issues, each with id, title, branch.
  const { issues } = PlannerOutputSchema.parse(JSON.parse(planMatch[1]!));

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    logger.info("No unblocked issues to work on. Exiting.");
    break;
  }

  logger.info({ count: issues.length }, "Planning complete");
  for (const issue of issues) {
    logger.info(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
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
