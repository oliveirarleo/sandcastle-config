import { pi, type RunOptions, type RunResult, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { PlannerIssue } from "../types.mts";

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;

/** Shim over child_process.exec for test injection. */
export type ShellExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

const defaultShell: ShellExec = promisify(exec) as ShellExec;

/**
 * Commit `.beads/issues.jsonl` if it has uncommitted changes.
 *
 * Beads auto-export (every 60s) can dirty this file while sandcastle agents
 * are running bd commands. If left dirty, `git merge` inside
 * withSandboxLifecycle fails with "local changes would be overwritten".
 * Committing these changes before the merger sandbox runs prevents the
 * conflict.
 */
async function commitBeadsExportIfDirty(
  shell: ShellExec,
  logger?: Logger,
): Promise<void> {
  try {
    const { stdout } = await shell("git status --porcelain .beads/issues.jsonl");
    if (!stdout.trim()) {
      return;
    }
    logger?.info("Beads export is dirty, committing before merge");
    await shell("git add .beads/issues.jsonl");
    await shell('git commit -m "chore: update beads export"');
    logger?.info("Committed beads export");
  } catch (err) {
    logger?.warn({ err }, "Failed to commit beads export — merge may fail if working tree is dirty");
  }
}

/**
 * Check if a branch is already merged into HEAD.
 * Returns true if `git branch --merged` lists the branch.
 */
async function isBranchMerged(
  branch: string,
  shell: ShellExec,
): Promise<boolean> {
  try {
    const { stdout } = await shell("git branch --merged");
    // Lines look like "  branch-name" or "* current-branch"
    return stdout.split("\n").some((line) => line.trim().replace(/^\*\s*/, "") === branch);
  } catch {
    return false;
  }
}

export interface MergePhaseOptions {
  runSandbox: RunSandbox;
  completedIssues: PlannerIssue[];
  sandboxProvider: SandboxProvider;
  hooks: SandboxHooks;
  logger?: Logger;
  /** Shell executor for git/pnpm commands (injectable for testing). */
  shell?: ShellExec;
}

export async function runMergePhase(opts: MergePhaseOptions): Promise<void>;
/** @deprecated Use the options-object overload. */
export async function runMergePhase(
  runSandbox: RunSandbox,
  completedIssues: PlannerIssue[],
  sandboxProvider: SandboxProvider,
  hooks: SandboxHooks,
  logger?: Logger,
): Promise<void>;
export async function runMergePhase(
  runSandboxOrOpts: RunSandbox | MergePhaseOptions,
  completedIssues?: PlannerIssue[],
  sandboxProvider?: SandboxProvider,
  hooks?: SandboxHooks,
  logger?: Logger,
): Promise<void> {
  let runSandbox: RunSandbox;
  let issues: PlannerIssue[];
  let provider: SandboxProvider;
  let hks: SandboxHooks;
  let log: Logger | undefined;
  let shell: ShellExec;

  if (typeof runSandboxOrOpts === "function") {
    // Legacy positional-args call
    runSandbox = runSandboxOrOpts;
    issues = completedIssues!;
    provider = sandboxProvider!;
    hks = hooks!;
    log = logger;
    shell = defaultShell;
  } else {
    const o = runSandboxOrOpts;
    runSandbox = o.runSandbox;
    issues = o.completedIssues;
    provider = o.sandboxProvider;
    hks = o.hooks;
    log = o.logger;
    shell = o.shell ?? defaultShell;
  }

  for (const issue of issues) {
    log?.info({ branch: issue.branch, issueId: issue.id }, "Merging branch");

    await commitBeadsExportIfDirty(shell, log);

    // Safety net: if the branch is already merged (e.g., manual merge),
    // skip the merger sandbox but still run pnpm install.
    const alreadyMerged = await isBranchMerged(issue.branch, shell);
    if (alreadyMerged) {
      log?.info(
        { branch: issue.branch, issueId: issue.id },
        "Branch already merged — skipping merger sandbox",
      );
    } else {
      try {
        await runSandbox({
          hooks: hks,
          sandbox: provider,
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
      } catch (err) {
        log?.error(
          { err, branch: issue.branch, issueId: issue.id },
          `Merge failed for ${issue.id} (${issue.branch}), continuing with remaining branches`,
        );
        continue;
      }
    }

    log?.info({ branch: issue.branch, issueId: issue.id }, "Running pnpm install after merge");
    try {
      await shell("CI=true pnpm install --no-frozen-lockfile");
    } catch (installErr) {
      log?.warn(
        { err: installErr, branch: issue.branch, issueId: issue.id },
        "pnpm install failed after merge — dependencies may be out of date",
      );
    }
  }
}
