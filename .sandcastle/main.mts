// Sandcastle daemon — four-phase poll loop (Plan → Execute → Merge).
// Runs indefinitely; SIGTERM triggers graceful shutdown after current iteration.

import * as sandcastle from "@ai-hero/sandcastle";
import pino from "pino";
import { sandboxProvider, MAX_PARALLEL_TASKS, POLL_INTERVAL_MS, hooks, copyToWorktree } from "./config.mts";
import { waitForOpenIssues } from "./helpers/issues.mts";
import { runExecutionPhase } from "./phases/execute.mts";
import { runMergePhase } from "./phases/merge.mts";
import { runPlanner } from "./phases/plan.mts";
import type { PlannerIssue } from "./types.mts";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

const GRACEFUL_SHUTDOWN_MS = 10 * 60 * 1000;

export async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) =>
    logger.error({ err: reason }, "Unhandled rejection — caught by safety net"));

  let shouldShutdown = false;
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received — will shut down after current iteration");
    shouldShutdown = true;
    setTimeout(() => {
      logger.fatal("Graceful shutdown timeout — forcing exit");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_MS).unref();
  });

  let iteration = 0;
  while (true) {
    iteration++;
    logger.info({ iteration }, "Heartbeat — starting iteration");

    const openIssues = await waitForOpenIssues(POLL_INTERVAL_MS, logger);
    logger.info({ count: openIssues.length, iteration }, "Poll complete");

    // Phase 1: Plan
    let issues: PlannerIssue[];
    try { issues = await runPlanner(sandcastle.run, sandboxProvider, hooks, logger); }
    catch (err) { logger.error({ err }, "Plan phase failed — exiting"); break; }
    if (issues.length === 0) { logger.info("No unblocked issues — exiting"); break; }

    // Phase 2: Execute + Review
    let completed: PlannerIssue[];
    try {
      completed = await runExecutionPhase(
        issues, sandcastle.createSandbox, sandboxProvider, hooks,
        copyToWorktree, MAX_PARALLEL_TASKS, logger);
    } catch (err) { logger.error({ err }, "Execute phase failed — continuing"); continue; }
    const branches = completed.map((i) => i.branch);
    logger.info({ count: branches.length }, "Execution complete");
    for (const b of branches) logger.info(`  ${b}`);
    if (branches.length === 0) {
      logger.info("No commits produced. Skipping merge.");
      continue;
    }

    // Phase 3: Merge
    try { await runMergePhase(sandcastle.run, completed, sandboxProvider, hooks, logger); }
    catch (err) { logger.error({ err }, "Merge phase failed — continuing"); continue; }
    logger.info("Branches merged.");

    if (shouldShutdown) {
      logger.info("Graceful shutdown — iteration complete");
      break;
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error — exiting");
  process.exit(1);
});
