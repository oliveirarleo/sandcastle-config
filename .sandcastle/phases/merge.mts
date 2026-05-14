import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { pi, type SandboxHooks, type SandboxProvider } from '@ai-hero/sandcastle';
import type { Logger } from 'pino';
import type { PlannerIssue, RunSandbox } from '../types.mts';

const execAsync = promisify(exec);

/**
 * Commit `.beads/issues.jsonl` if it has uncommitted changes.
 *
 * Beads auto-export (every 60s) can dirty this file while sandcastle agents
 * are running bd commands. If left dirty, `git merge` inside
 * withSandboxLifecycle fails with "local changes would be overwritten".
 * Committing these changes before the merger sandbox runs prevents the
 * conflict.
 */
async function commitBeadsExportIfDirty(logger?: Logger): Promise<void> {
  try {
    const { stdout } = await execAsync('git status --porcelain .beads/issues.jsonl');
    if (!stdout.trim()) {
      return;
    }
    logger?.info('Beads export is dirty, committing before merge');
    await execAsync('git add .beads/issues.jsonl');
    await execAsync('git commit -m "chore: update beads export"');
    logger?.info('Committed beads export');
  } catch (err) {
    logger?.warn(
      { err },
      'Failed to commit beads export — merge may fail if working tree is dirty',
    );
  }
}

/**
 * Run `pnpm install` after a merge to pick up dependency changes from
 * the merged branch. Failure is non-fatal — a warning is logged but the
 * merge loop continues.
 */
async function installDependencies(
  logger: Logger | undefined,
  branch: string,
  issueId: string,
): Promise<void> {
  try {
    await execAsync('CI=true pnpm install --no-frozen-lockfile');
  } catch (err) {
    logger?.warn(
      { err, branch, issueId },
      'pnpm install failed after merge — dependencies may be out of date',
    );
  }
}

export async function runMergePhase(
  runSandbox: RunSandbox,
  completedIssues: PlannerIssue[],
  sandboxProvider: SandboxProvider,
  hooks: SandboxHooks,
  logger?: Logger,
): Promise<void> {
  for (const issue of completedIssues) {
    logger?.info({ branch: issue.branch, issueId: issue.id }, 'Merging branch');

    await commitBeadsExportIfDirty(logger);

    try {
      await runSandbox({
        hooks,
        sandbox: sandboxProvider,
        name: 'merger',
        maxIterations: 1,
        agent: pi('opencode-go/deepseek-v4-pro'),
        promptFile: './.sandcastle/merge-prompt.md',
        branchStrategy: { type: 'merge-to-head' },
        promptArgs: {
          BRANCHES: `- ${issue.branch}`,
          ISSUES: `- ${issue.id}: ${issue.title}`,
        },
      });

      logger?.info({ branch: issue.branch, issueId: issue.id }, 'Running pnpm install after merge');
      await installDependencies(logger, issue.branch, issue.id);
    } catch (err) {
      logger?.error(
        { err, branch: issue.branch, issueId: issue.id },
        `Merge failed for ${issue.id} (${issue.branch}), continuing with remaining branches`,
      );
    }
  }
}
