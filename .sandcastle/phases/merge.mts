import { pi, type RunOptions, type RunResult, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { PlannerIssue } from "../types.mts";

const execAsync = promisify(exec);

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;

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
    // Check if .beads/issues.jsonl has staged or unstaged changes
    const { stdout } = await execAsync("git status --porcelain .beads/issues.jsonl");
    if (!stdout.trim()) {
      return; // clean, nothing to do
    }
    logger?.info("Beads export is dirty, committing before merge");
    await execAsync("git add .beads/issues.jsonl");
    await execAsync('git commit -m "chore: update beads export"');
    logger?.info("Committed beads export");
  } catch (err) {
    // Non-fatal: if the working tree is still dirty, the merge will fail
    // with a clear error rather than silently swallowing the problem.
    logger?.warn({ err }, "Failed to commit beads export — merge may fail if working tree is dirty");
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
    logger?.info({ branch: issue.branch, issueId: issue.id }, "Merging branch");

    // Commit any outstanding beads export before merge to avoid dirty-tree
    // merge failures inside the sandcastle SDK's merge-to-head step.
    await commitBeadsExportIfDirty(logger);

    try {
      await runSandbox({
        hooks,
        sandbox: sandboxProvider,
        name: "merger",
        maxIterations: 1,
        agent: pi("opencode-go/deepseek-v4-pro"),
        promptFile: "./.sandcastle/merge-prompt.md",
        branchStrategy: { type: "merge-to-head" },
        promptArgs: {
          BRANCHES: `- ${issue.branch}`,
          ISSUES: `- ${issue.id}: ${issue.title}`,
        },
      });

      // Install dependencies after merge — merged branches may have
      // added, removed, or updated packages.
      logger?.info({ branch: issue.branch, issueId: issue.id }, "Running pnpm install after merge");
      try {
        await execAsync("CI=true pnpm install --no-frozen-lockfile");
      } catch (installErr) {
        logger?.warn(
          { err: installErr, branch: issue.branch, issueId: issue.id },
          "pnpm install failed after merge — dependencies may be out of date",
        );
      }
    } catch (err) {
      logger?.error(
        { err, branch: issue.branch, issueId: issue.id },
        `Merge failed for ${issue.id} (${issue.branch}), continuing with remaining branches`,
      );
    }
  }
}
