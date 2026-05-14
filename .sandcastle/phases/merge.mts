import {
	pi,
	type RunOptions,
	type RunResult,
	type SandboxHooks,
	type SandboxProvider,
} from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import type { PlannerIssue } from "../types.mts";

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;

export async function runMergePhase(
	runSandbox: RunSandbox,
	completedIssues: PlannerIssue[],
	sandboxProvider: SandboxProvider,
	hooks: SandboxHooks,
	logger?: Logger,
): Promise<void> {
	for (const issue of completedIssues) {
		logger?.info({ branch: issue.branch, issueId: issue.id }, "Merging branch");
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
	}
}
