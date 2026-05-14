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

export async function runExecutionPhase(
  issues: PlannerIssue[],
  createSandbox: CreateSandboxFn,
  sandboxProvider: SandboxProvider,
  hooks: SandboxHooks,
  copyToWorktree: string[],
  maxParallelTasks: number,
  logger?: Logger,
): Promise<PlannerIssue[]> {
  const settled = await runWithConcurrencyLimit(
    issues,
    maxParallelTasks,
    async (issue) => {
      const sandbox = await createSandbox({
        branch: issue.branch,
        sandbox: sandboxProvider,
        hooks,
        copyToWorktree,
      });

      try {
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: pi("opencode-go/kimi-k2.6"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        if (implement.commits.length > 0) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: pi("opencode-go/kimi-k2.6"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
            },
          });

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
