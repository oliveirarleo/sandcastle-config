import * as sandcastle from "@ai-hero/sandcastle";

export interface MergeableIssue {
  branch: string;
  id: string;
  title: string;
}

export type RunSandbox = typeof sandcastle.run;

export async function runMergePhase(
  runSandbox: RunSandbox,
  completedIssues: MergeableIssue[],
  sandboxProvider: any,
  hooks: any,
): Promise<void> {
  for (const issue of completedIssues) {
    await runSandbox({
      hooks,
      sandbox: sandboxProvider,
      name: "merger",
      maxIterations: 1,
      agent: sandcastle.pi("opencode-go/kimi-k2.6"),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        BRANCHES: `- ${issue.branch}`,
        ISSUES: `- ${issue.id}: ${issue.title}`,
      },
    });
  }
}
