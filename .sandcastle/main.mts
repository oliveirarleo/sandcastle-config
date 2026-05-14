// Sandcastle daemon — four-phase poll loop (Plan → Execute → Merge).
// Runs indefinitely; SIGTERM triggers graceful shutdown after current iteration.
// Persists per-issue phase labels on bead issues for crash-resume support.

import * as sandcastle from "@ai-hero/sandcastle";
import { $ } from "zx";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import pino from "pino";
import { sandboxProvider, MAX_PARALLEL_TASKS, POLL_INTERVAL_MS, hooks, copyToWorktree } from "./config.mts";
import { waitForOpenIssues, getIssuesByLabel } from "./helpers/issues.mts";
import {
  LABEL_PLANNED,
  LABEL_EXECUTING,
  LABEL_REVIEWING,
  LABEL_EXECUTED,
  LABEL_MERGED,
  bdAddLabelCmd,
} from "./helpers/labels.mts";
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

const shell = promisify(exec);

/**
 * Run a bd update command to add a label to an issue.
 * Errors are logged but not thrown — label operations are best-effort.
 */
async function addLabel(issueId: string, label: string): Promise<void> {
  const cmd = bdAddLabelCmd(issueId, label);
  try {
    await shell(cmd);
    logger.info({ issueId, label }, "Label added");
  } catch (err) {
    logger.warn({ err, issueId, label }, "Failed to add label");
  }
}

/**
 * Check if any open issues have sandcastle phase labels beyond `planned`.
 * If so, return them as PlannerIssue-shaped objects for routing.
 * We only route `executing`, `reviewing`, and `executed` — `merged` is skipped.
 */
async function collectResumeIssues(): Promise<{
  executing: PlannerIssue[];
  reviewing: PlannerIssue[];
  executed: PlannerIssue[];
}> {
  const byLabel = async (label: string): Promise<PlannerIssue[]> => {
    const issues = await getIssuesByLabel(label, logger);
    return issues.map((i) => ({
      id: i.id,
      title: i.title,
      branch: `sandcastle/${i.id}-resume`,
    }));
  };

  const executing = await byLabel(LABEL_EXECUTING);
  const reviewing = await byLabel(LABEL_REVIEWING);
  const executed = await byLabel(LABEL_EXECUTED);

  return { executing, reviewing, executed };
}

/**
 * Handle resume routing: dispatch issues to the correct phase based on
 * their current sandcastle label, then continue the normal daemon loop.
 */
async function handleResume(): Promise<boolean> {
  const { executing, reviewing, executed } = await collectResumeIssues();
  const total = executing.length + reviewing.length + executed.length;

  if (total === 0) {
    return false; // no resume needed
  }

  logger.info(
    { executing: executing.length, reviewing: reviewing.length, executed: executed.length },
    "Resume detected — routing issues to their last phase",
  );

  // executing + reviewing → run through execute phase (resume implementer/reviewer)
  const executeIssues = [...executing, ...reviewing];
  let completed: PlannerIssue[] = [];

  if (executeIssues.length > 0) {
    try {
      completed = await runExecutionPhase(
        executeIssues,
        sandcastle.createSandbox,
        sandboxProvider,
        hooks,
        copyToWorktree,
        MAX_PARALLEL_TASKS,
        logger,
        {
          onImplementStart: async (id) => { await addLabel(id, LABEL_EXECUTING); },
          onReviewStart: async (id) => { await addLabel(id, LABEL_REVIEWING); },
          onExecuteComplete: async (id) => { await addLabel(id, LABEL_EXECUTED); },
        },
      );
    } catch (err) {
      logger.error({ err }, "Resume execute phase failed");
    }
  }

  // executed + newly-completed → merge
  const mergeIssues = [...executed, ...completed];
  if (mergeIssues.length > 0) {
    try {
      await runMergePhase({
        runSandbox: sandcastle.run,
        completedIssues: mergeIssues,
        sandboxProvider,
        hooks,
        logger,
      });
    } catch (err) {
      logger.error({ err }, "Resume merge phase failed");
    }
  }

  return true;
}

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

  // Resume: if the daemon was stopped mid-execution, pick up where we left off.
  try {
    await handleResume();
  } catch (err) {
    logger.error({ err }, "Resume check failed — continuing with normal flow");
  }

  let iteration = 0;
  while (true) {
    iteration++;
    logger.info({ iteration }, "Heartbeat — starting iteration");

    const openIssues = await waitForOpenIssues(POLL_INTERVAL_MS, logger);
    logger.info({ count: openIssues.length, iteration }, "Poll complete");

    // Phase 1: Plan
    let issues: PlannerIssue[];
    try {
      issues = await runPlanner(sandcastle.run, sandboxProvider, hooks, logger);
    } catch (err) {
      logger.error({ err }, "Plan phase failed — exiting");
      break;
    }

    if (issues.length === 0) {
      logger.info("No unblocked issues — exiting");
      break;
    }

    // Label each planned issue so resume knows they were planned.
    for (const issue of issues) {
      await addLabel(issue.id, LABEL_PLANNED);
    }

    // Phase 2: Execute + Review
    let completed: PlannerIssue[];
    try {
      completed = await runExecutionPhase(
        issues,
        sandcastle.createSandbox,
        sandboxProvider,
        hooks,
        copyToWorktree,
        MAX_PARALLEL_TASKS,
        logger,
        {
          onImplementStart: async (id) => { await addLabel(id, LABEL_EXECUTING); },
          onReviewStart: async (id) => { await addLabel(id, LABEL_REVIEWING); },
          onExecuteComplete: async (id) => { await addLabel(id, LABEL_EXECUTED); },
        },
      );
    } catch (err) {
      logger.error({ err }, "Execute phase failed — continuing");
      continue;
    }

    const branches = completed.map((i) => i.branch);
    logger.info({ count: branches.length }, "Execution complete");
    for (const b of branches) {
      logger.info(`  ${b}`);
    }

    if (branches.length === 0) {
      logger.info("No commits produced. Skipping merge.");
      continue;
    }

    // Phase 3: Merge
    try {
      await runMergePhase({
        runSandbox: sandcastle.run,
        completedIssues: completed,
        sandboxProvider,
        hooks,
        logger,
      });
    } catch (err) {
      logger.error({ err }, "Merge phase failed — continuing");
      continue;
    }

    // Label successfully-merged issues.
    for (const issue of completed) {
      await addLabel(issue.id, LABEL_MERGED);
    }

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
