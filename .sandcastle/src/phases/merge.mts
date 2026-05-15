import { pi, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import { formatErrorMessage, type Notifier } from "../helpers/notifier.mts";
import { $ } from "zx";
import type { PlannerIssue, RunSandbox } from "../types.mts";

$.verbose = false;

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Execute a shell command string via zx.
 *
 * Uses `sh -c` because the input is a command string, not a template literal
 * with individual arguments that zx would otherwise escape.
 */
async function execShell(cmd: string): Promise<{ stdout: string; stderr: string }> {
	const result = await $`sh -c ${cmd}`.quiet();
	return { stdout: result.stdout, stderr: result.stderr };
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
		await $`CI=true pnpm install --no-frozen-lockfile`.quiet();
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
	execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = execShell,
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
	notifier?: Notifier,
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

			notifier
				?.send({
					level: "info",
					title: `Merged ${issue.branch}`,
					message: `Branch ${issue.branch} (${issue.id}: ${issue.title}) merged successfully.`,
					tags: ["merge", "sandcastle"],
				})
				.catch(() => {});

			await onMergeComplete?.(issue.id);

			logger?.info({ branch: issue.branch, issueId: issue.id }, "Running pnpm install after merge");
			await installDependencies(logger, issue.branch, issue.id);
		} catch (err) {
			logger?.error(
				{ err, branch: issue.branch, issueId: issue.id },
				`Merge failed for ${issue.id} (${issue.branch}), continuing with remaining branches`,
			);

			notifier
				?.send({
					level: "warn",
					title: `Merge failed: ${issue.branch}`,
					message: `Branch ${issue.branch} (${issue.id}) merge failed: ${formatErrorMessage(err)}`,
					tags: ["merge", "sandcastle", "error"],
				})
				.catch(() => {});
		}
	}
}
