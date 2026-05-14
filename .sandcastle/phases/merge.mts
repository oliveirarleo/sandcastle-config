import * as sandcastle from "@ai-hero/sandcastle";
import type {
  RunOptions,
  RunResult,
  SandboxHooks,
  SandboxProvider,
} from "@ai-hero/sandcastle";
import type { Logger } from "pino";

export interface MergeableIssue {
  branch: string;
  id: string;
  title: string;
}

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;

export async function runMergePhase(
  runSandbox: RunSandbox,
  completedIssues: MergeableIssue[],
  sandboxProvider: SandboxProvider,
  hooks: SandboxHooks,
  logger?: Logger,
): Promise<void> {
  for (const issue of completedIssues) {
    logger?.info({ branch: issue.branch, issue: issue.id }, "Merging branch");
    await runSandbox({
      hooks,
      sandbox: sandboxProvider,
      name: "merger",
      maxIterations: 1,
      agent: sandcastle.pi("opencode-go/kimi-k2.6"),
      promptFile: "./.sandcastle/merge-prompt.md",
      branchStrategy: { type: "merge-to-head" },
      promptArgs: {
        BRANCHES: `- ${issue.branch}`,
        ISSUES: `- ${issue.id}: ${issue.title}`,
      },
    });
  }
}
