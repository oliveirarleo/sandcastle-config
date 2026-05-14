import { pi, type SandboxRunOptions, type SandboxRunResult, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import type { PlannerIssue } from "../types.mts";
import { runWithConcurrencyLimit } from "../helpers/concurrency.mts";

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
): Promise<PlannerIssue[]> {
  async function executeOneIssue(issue: PlannerIssue): Promise<SandboxRunResult> {
    const sandbox = await createSandbox({
      branch: issue.branch,
      sandbox: sandboxProvider,
      hooks,
      copyToWorktree,
    });

    try {
      const implementResult = await sandbox.run({
        name: "implementer",
        maxIterations: 100,
        agent: pi("opencode-go/deepseek-v4-pro"),
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      });

      if (implementResult.commits.length > 0) {
        const reviewResult = await sandbox.run({
          name: "reviewer",
          maxIterations: 1,
          agent: pi("opencode-go/deepseek-v4-pro"),
          promptFile: "./.sandcastle/review-prompt.md",
          promptArgs: { BRANCH: issue.branch },
        });

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
    if (outcome.status === "rejected") {
      const issue = issues[i];
      if (issue) {
        logger?.error({ err: outcome.reason }, `✗ ${issue.id} (${issue.branch}) failed`);
      }
    }
  }

  const completedIssues = settled.flatMap((outcome, i) => {
    const issue = issues[i];
    if (outcome.status === "fulfilled" && outcome.value.commits.length > 0 && issue) {
      return [issue];
    }
    return [];
  });

  return completedIssues;
}
