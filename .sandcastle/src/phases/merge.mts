import { pi, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import { $ } from "zx";
import { runPhaseHook } from "../helpers/hooks.mts";
import { EXECUTED, MERGED } from "../helpers/labels.mts";
import { formatErrorMessage, type Notifier } from "../helpers/notifier.mts";
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
 * Default exec function for bd commands.
 * Returns trimmed stdout from the shell command.
 */
async function defaultBdExec(cmd: string): Promise<string> {
	const { stdout } = await execShell(cmd);
	return stdout.trim();
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
	if (process.env.VITEST) return;
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

/**
 * Check if a bead issue is closed via `bd show --json`.
 */
export async function isIssueClosed(
	issueId: string,
	execFn: (cmd: string) => Promise<{ stdout: string; stderr: string }> = execShell,
): Promise<boolean> {
	try {
		const { stdout } = await execFn(`bd show "${issueId}" --json`);
		const parsed = JSON.parse(stdout);
		const status = parsed?.data?.[0]?.status;
		return status === "closed";
	} catch {
		return false;
	}
}

/**
 * Verify merged-labeled issues during resume (safety net).
 *
 * For each issue with a sandcastle:merged label:
 * 1. Check if the branch is actually merged (git branch --merged)
 * 2. If merged, check if the bead ticket is closed (bd show --json)
 * 3. If branch merged but ticket open → bd close
 * 4. If branch NOT merged → revert label to executed for re-merge
 *
 * @returns The issues whose labels were reverted (need re-merge).
 */
export async function verifyMergedIssues(
	issues: PlannerIssue[],
	deps?: {
		logger?: Logger;
		isBranchMergedFn?: (branch: string) => Promise<{ stdout: string; stderr: string }>;
		isIssueClosedFn?: (issueId: string) => Promise<{ stdout: string; stderr: string }>;
		exec?: (cmd: string) => Promise<string>;
	},
): Promise<PlannerIssue[]> {
	const reverted: PlannerIssue[] = [];
	const ex = deps?.exec ?? defaultBdExec;

	for (const issue of issues) {
		try {
			const branchMerged = await isBranchMerged(issue.branch, deps?.isBranchMergedFn);

			if (branchMerged) {
				const closed = await isIssueClosed(issue.id, deps?.isIssueClosedFn);

				if (!closed) {
					// Branch merged but ticket open — close it
					await ex(`bd close "${issue.id}" --reason "Safety net: branch already merged"`);
				}
			} else {
				// Label says merged but branch NOT merged — revert label
				await ex(`bd label remove "${issue.id}" ${MERGED}`);
				await ex(`bd label add "${issue.id}" ${EXECUTED}`);
				reverted.push(issue);
			}
		} catch (err) {
			deps?.logger?.error(
				{ err, issueId: issue.id, branch: issue.branch },
				"Safety net check failed for issue",
			);
		}
	}

	return reverted;
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

			// ---- Pre-merge hook (non-fatal) ----
			await runPhaseHook(issue.id, "pre_merge", logger);

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

			// ---- Post-merge hook (non-fatal) ----
			await runPhaseHook(issue.id, "post_merge", logger);

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
