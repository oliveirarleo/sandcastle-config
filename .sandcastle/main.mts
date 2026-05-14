// Parallel Planner with Review — three-phase orchestration loop
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
// Resume support: on startup, checks bead issue labels for sandcastle:*
// labels. If any executing/reviewing/executed/merged labels are found, the
// planner is skipped and issues are routed directly to their correct phase.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.

import * as sandcastle from '@ai-hero/sandcastle';
import pino from 'pino';
import { $ } from 'zx';
import {
  copyToWorktree,
  hooks,
  MAX_ITERATIONS,
  MAX_PARALLEL_TASKS,
  POLL_INTERVAL_MS,
  sandboxProvider,
} from './config.mts';
import { getIssuesByLabel, waitForOpenIssues } from './helpers/issues.mts';
import {
  addLabelCmd,
  EXECUTED,
  EXECUTING,
  MERGED,
  PLANNED,
  REVIEWING,
  shouldSkipPlanner,
} from './helpers/labels.mts';
import { runExecutionPhase } from './phases/execute.mts';
import { runMergePhase } from './phases/merge.mts';
import { runPlanner } from './phases/plan.mts';
import type { PlannerIssue } from './types.mts';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Process-level safety net
// ---------------------------------------------------------------------------
// Catches stray unhandled rejections (e.g. Effect defects from orDie /
// uncaught Effect.runPromise) that would otherwise crash the process.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection caught by safety net');
});

// ---------------------------------------------------------------------------
// Label management helpers
// ---------------------------------------------------------------------------

/** Remove a previous sandcastle:* label and add the new one for an issue. */
async function _transitionLabel(
  issueId: string,
  fromLabel: string,
  toLabel: string,
): Promise<void> {
  try {
    await $`bd update "${issueId}" --remove-label ${fromLabel} --add-label ${toLabel}`;
    logger.debug({ issueId, from: fromLabel, to: toLabel }, 'Label transition');
  } catch (err) {
    logger.warn({ err, issueId, from: fromLabel, to: toLabel }, 'Label transition failed');
  }
}

/** Add a label to an issue without removing the existing one. */
async function addLabel(issueId: string, label: string): Promise<void> {
  try {
    await $({ quiet: true })`${addLabelCmd(issueId, label)}`;
    logger.debug({ issueId, label }, 'Label added');
  } catch (err) {
    logger.warn({ err, issueId, label }, 'Label add failed');
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Check for resume mode — if any issues are mid-lifecycle, skip the planner
// and route them directly to the correct phase.
let issues: PlannerIssue[] = [];
let needsPlanner = false;

try {
  const allOpen = await waitForOpenIssues(POLL_INTERVAL_MS, logger);
  needsPlanner = !shouldSkipPlanner(allOpen);
  logger.info({ count: allOpen.length, needsPlanner }, 'Startup check');
} catch (err) {
  logger.error({ err }, 'Startup check failed — defaulting to fresh planner run');
  needsPlanner = true;
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  // -----------------------------------------------------------------------
  // Phase 1: Plan (skipped on resume)
  // -----------------------------------------------------------------------

  if (needsPlanner) {
    // Reset flag — subsequent iterations use the normal flow.
    needsPlanner = false;

    try {
      issues = await runPlanner(
        sandcastle.run,
        sandboxProvider,
        hooks,
        logger,
        async (plannedIssues) => {
          // Label each planned issue as sandcastle:planned
          for (const issue of plannedIssues) {
            await addLabel(issue.id, PLANNED);
          }
        },
      );
    } catch (err) {
      logger.error({ err }, 'Phase 1 (plan) failed — exiting loop');
      break;
    }

    if (issues.length === 0) {
      logger.info('No unblocked issues to work on. Exiting.');
      break;
    }
  } else {
    // Resume mode: collect issues by label and route to correct phase.
    // Collect issues labeled executing, reviewing, planned → execute phase.
    // Collect issues labeled executed → merge phase.
    // Issues labeled merged → skip.

    const executingIssues = await getIssuesByLabel(EXECUTING, logger);
    const reviewingIssues = await getIssuesByLabel(REVIEWING, logger);
    const plannedIssues = await getIssuesByLabel(PLANNED, logger);
    const executedIssues = await getIssuesByLabel(EXECUTED, logger);

    // Build PlannerIssue entries from bead issues
    const resumeIssues = [...plannedIssues, ...executingIssues, ...reviewingIssues].map((i) => ({
      id: i.id,
      title: i.title,
      branch: `sandcastle/issue-${i.id}`,
    }));

    const mergeIssues = executedIssues.map((i) => ({
      id: i.id,
      title: i.title,
      branch: `sandcastle/issue-${i.id}`,
    }));

    logger.info(
      {
        executeCount: resumeIssues.length,
        mergeCount: mergeIssues.length,
      },
      'Resume routing',
    );

    issues = resumeIssues;

    if (resumeIssues.length === 0 && mergeIssues.length === 0) {
      // All issues are either merged or have no sandcastle labels.
      // Fall back to fresh planner run next iteration.
      logger.info('No resume issues found. Will run planner fresh next iteration.');
      needsPlanner = true;
      continue;
    }
  }

  if (issues.length === 0) {
    logger.info('No issues to execute. Exiting.');
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
      {
        onImplementStart: async (issueId) => {
          await addLabel(issueId, EXECUTING);
        },
        onReviewStart: async (issueId) => {
          await addLabel(issueId, REVIEWING);
        },
        onExecuteComplete: async (issueId) => {
          await addLabel(issueId, EXECUTED);
        },
      },
    );
  } catch (err) {
    logger.error({ err }, 'Phase 2 (execute) failed — skipping merge, continuing loop');
    continue;
  }

  const completedBranches = completedIssues.map((i) => i.branch);

  logger.info({ count: completedBranches.length }, 'Execution complete');
  for (const branch of completedBranches) {
    logger.info(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    logger.info('No commits produced. Nothing to merge.');
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
    await runMergePhase(
      sandcastle.run,
      completedIssues,
      sandboxProvider,
      hooks,
      logger,
      async (issueId) => {
        await addLabel(issueId, MERGED);
      },
    );
  } catch (err) {
    logger.error({ err }, 'Phase 3 (merge) failed — continuing loop');
    continue;
  }

  logger.info('Branches merged.');
}
