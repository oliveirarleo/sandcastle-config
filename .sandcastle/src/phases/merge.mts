import { exec } from "node:child_process";
import { promisify } from "node:util";
import { pi, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import type { PlannerIssue, RunSandbox } from "../types.mts";

const execAsync = promisify(exec);

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
		await execAsync("CI=true pnpm install --no-frozen-lockfile");
	} catch (err) {
		logger?.warn(
			{ err, branch, issueId },
			"pnpm install failed after merge — dependencies may be out of date",
		);
	}
}

/**
 * Check if a branch has already been merged into HEAD.
 */
export async function isBranchMerged(
	branch: string,
	execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = (cmd) => execAsync(cmd),
): Promise<boolean> {
	try {
		const { stdout } = await execFn("git branch --merged HEAD");
		return stdout.split("\n").some((line) => line.trim().replace(/^\*?\s+/, "") === branch);
	} catch {
		return false;
	}
}

export async function runMergePhase(
	runSandbox: RunSandbox,
	completedIssues: PlannerIssue[],
	sandboxProvider: SandboxProvider,
	hooks: SandboxHooks,
	logger?: Logger,
	onMergeComplete?: (issueId: string) => Promise<void>,
): Promise<void> {
	for (const issue of completedIssues) {
		logger?.info({ branch: issue.branch, issueId: issue.id }, "Merging branch");

		try {
			// Skip merge if branch is already merged into HEAD (safety net)
			const alreadyMerged = await isBranchMerged(issue.branch);
			if (alreadyMerged) {
				logger?.info(
					{ branch: issue.branch, issueId: issue.id },
					"Branch already merged (git branch --merged). Skipping merge, updating label.",
				);
				await onMergeComplete?.(issue.id);
				continue;
			}

			await runSandbox({
				hooks,
				sandbox: sandboxProvider,
				name: "merger",
				maxIterations: 1,
				agent: pi("opencode-go/deepseek-v4-flash"),
				promptFile: "./.sandcastle/prompts/merge.md",
				branchStrategy: { type: "merge-to-head" },
				promptArgs: {
					BRANCHES: `- ${issue.branch}`,
					ISSUES: `- ${issue.id}: ${issue.title}`,
				},
			});

			await onMergeComplete?.(issue.id);

			logger?.info({ branch: issue.branch, issueId: issue.id }, "Running pnpm install after merge");
			await installDependencies(logger, issue.branch, issue.id);
		} catch (err) {
			logger?.error(
				{ err, branch: issue.branch, issueId: issue.id },
				`Merge failed for ${issue.id} (${issue.branch}), continuing with remaining branches`,
			);
		}
	}
}
