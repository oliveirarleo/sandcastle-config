import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  pi,
  type SandboxHooks,
  type SandboxProvider,
  type SandboxRunOptions,
  type SandboxRunResult,
} from '@ai-hero/sandcastle';
import type { Logger } from 'pino';
import { runWithConcurrencyLimit } from '../helpers/concurrency.mts';
import type { PlannerIssue } from '../types.mts';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Label callbacks
// ---------------------------------------------------------------------------

/**
 * Callbacks for updating bead issue labels during the execute phase.
 *
 * These are called at key lifecycle points so sandcastle can persist phase
 * state. When a crash occurs, the labels tell sandcastle where to resume.
 */
export interface ExecuteLabelCallbacks {
  /** Called when the implementer agent starts running for an issue. */
  onImplementStart?: (issueId: string) => Promise<void>;
  /** Called when the reviewer agent starts running for an issue. */
  onReviewStart?: (issueId: string) => Promise<void>;
  /** Called after implement + review complete successfully (commits produced). */
  onExecuteComplete?: (issueId: string) => Promise<void>;
}

export type CreateSandboxFn = (options: {
  branch: string;
  sandbox: SandboxProvider;
  hooks?: SandboxHooks;
  copyToWorktree?: string[];
}) => Promise<{
  run: (options: SandboxRunOptions) => Promise<SandboxRunResult>;
  close: () => Promise<unknown>;
}>;

/**
 * Run implementer + reviewer sandbox pipelines for each planned issue.
 *
 * Each issue gets its own sandbox. The implementer runs first; if it produces
 * commits, a reviewer runs in the same sandbox. All issue pipelines run
 * concurrently (bounded by {@link maxParallelTasks}). Errors in one pipeline
 * don't cancel the others — rejected pipelines are logged and skipped.
 *
 * @returns The subset of issues that produced at least one commit.
 */
export async function runExecutionPhase(
  issues: PlannerIssue[],
  createSandbox: CreateSandboxFn,
  sandboxProvider: SandboxProvider,
  hooks: SandboxHooks,
  copyToWorktree: string[],
  maxParallelTasks: number,
  logger?: Logger,
  labelCallbacks?: ExecuteLabelCallbacks,
): Promise<PlannerIssue[]> {
  async function executeOneIssue(issue: PlannerIssue): Promise<SandboxRunResult> {
    const sandbox = await createSandbox({
      branch: issue.branch,
      sandbox: sandboxProvider,
      hooks,
      copyToWorktree,
    });

    try {
      await labelCallbacks?.onImplementStart?.(issue.id);

      const implementResult = await sandbox.run({
        name: 'implementer',
        maxIterations: 100,
        agent: pi('opencode-go/deepseek-v4-pro'),
        promptFile: './.sandcastle/implement-prompt.md',
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      });

      if (implementResult.commits.length > 0) {
        // Run Biome linter + formatter on the implementer's changes.
        // Auto-commit fixes so the reviewer sees clean, style-compliant code.
        try {
          await execAsync('pnpm check');
          const { stdout: statusOut } = await execAsync('git status --porcelain');
          if (statusOut.trim()) {
            await execAsync('git add -A');
            await execAsync('git commit -m "chore: biome fixes"');
            logger?.info({ issueId: issue.id }, 'Biome applied fixes, committed');
          }
        } catch (biomeErr) {
          // Non-fatal: the reviewer may still catch style issues.
          logger?.warn(
            { err: biomeErr, issueId: issue.id },
            'Biome check failed — continuing to reviewer',
          );
        }

        await labelCallbacks?.onReviewStart?.(issue.id);

        const reviewResult = await sandbox.run({
          name: 'reviewer',
          maxIterations: 1,
          agent: pi('opencode-go/deepseek-v4-pro'),
          promptFile: './.sandcastle/review-prompt.md',
          promptArgs: { BRANCH: issue.branch },
        });

        await labelCallbacks?.onExecuteComplete?.(issue.id);

        return {
          ...reviewResult,
          commits: [...implementResult.commits, ...reviewResult.commits],
        };
      }

      return implementResult;
    } finally {
      await sandbox.close();
    }
  }

  const settled = await runWithConcurrencyLimit(issues, maxParallelTasks, executeOneIssue);

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      const issue = issues[i];
      if (issue) {
        logger?.error({ err: outcome.reason }, `✗ ${issue.id} (${issue.branch}) failed`);
      }
    }
  }

  const completedIssues = settled.flatMap((outcome, i) => {
    const issue = issues[i];
    if (outcome.status === 'fulfilled' && outcome.value.commits.length > 0 && issue) {
      return [issue];
    }
    return [];
  });

  return completedIssues;
}
