import {
	pi,
	type SandboxHooks,
	type SandboxProvider,
	type SandboxRunOptions,
	type SandboxRunResult,
} from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import { $ } from "zx";
import { runWithConcurrencyLimit } from "../helpers/concurrency.mts";
import { runPhaseHook } from "../helpers/hooks.mts";
import { EXECUTED, EXECUTING, REVIEWING } from "../helpers/labels.mts";
import { formatErrorMessage, type Notifier } from "../helpers/notifier.mts";
import type { PlannerIssue } from "../types.mts";

$.verbose = false;

// ---------------------------------------------------------------------------
// Label callbacks
// ---------------------------------------------------------------------------

/**
 * Callbacks for updating bead issue labels during the execute phase.
 *
 * These are called at key lifecycle points so sandcastle can persist phase
 * state. When a crash occurs, the labels tell sandcastle where to resume.
 */
export interface ExecuteLabelCallbacks {
	/** Called when the implementer agent starts running for an issue. */
	onImplementStart?: (issueId: string) => Promise<void>;
	/** Called when the reviewer agent starts running for an issue. */
	onReviewStart?: (issueId: string) => Promise<void>;
	/** Called after implement + review complete, or when zero commits produced.
	 * Always transitions the label forward so the issue is not stuck at executing. */
	onExecuteComplete?: (issueId: string) => Promise<void>;
	/**
	 * Called after the implementer run finishes, with the session ID if one was
	 * captured. The caller should persist this as issue metadata so the next
	 * run can resume from this session.
	 */
	onImplementSession?: (issueId: string, sessionId?: string) => Promise<void>;
	/**
	 * Called after the reviewer run finishes, with the session ID if one was
	 * captured. The caller should persist this as issue metadata so the next
	 * run can resume from this session.
	 */
	onReviewSession?: (issueId: string, sessionId?: string) => Promise<void>;
	/**
	 * Validate that a session ID corresponds to an existing session file.
	 * Return `true` if the session is valid, `false` if stale (file missing).
	 * When stale, the execute phase logs a warning and falls back to a fresh
	 * agent start instead of crashing.
	 */
	onValidateSession?: (sessionId: string) => Promise<boolean>;
	/**
	 * Called when an issue's implementer or reviewer throws and the phase
	 * label is reverted one step. The `currentLabel` is the label that was
	 * set before the crash (the one being reverted from).
	 */
	onCrash?: (issueId: string, currentLabel: string) => Promise<void>;
}

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
	labelCallbacks?: ExecuteLabelCallbacks,
	notifier?: Notifier,
): Promise<PlannerIssue[]> {
	async function executeOneIssue(rawIssue: PlannerIssue): Promise<SandboxRunResult> {
		// Resolve stale sessions before creating the sandbox.
		// We mutate a local copy so the original object is unaffected.
		let issue = rawIssue;

		if (issue.implementSession) {
			const valid = (await labelCallbacks?.onValidateSession?.(issue.implementSession)) ?? true;
			if (!valid) {
				logger?.warn(
					{ issueId: issue.id, sessionId: issue.implementSession },
					"Implementer session file not found — falling back to fresh start",
				);
				issue = { ...issue, implementSession: undefined };
			}
		}

		if (issue.reviewSession) {
			const valid = (await labelCallbacks?.onValidateSession?.(issue.reviewSession)) ?? true;
			if (!valid) {
				logger?.warn(
					{ issueId: issue.id, sessionId: issue.reviewSession },
					"Reviewer session file not found — falling back to fresh start",
				);
				issue = { ...issue, reviewSession: undefined };
			}
		}

		const sandbox = await createSandbox({
			branch: issue.branch,
			sandbox: sandboxProvider,
			hooks,
			copyToWorktree,
		});

		let lastPhaseLabel: string | undefined;
		let implementResult: SandboxRunResult | undefined;

		try {
			// ---- Pre-execute hook (non-fatal) ----
			await runPhaseHook(issue.id, "pre_execute", logger);

			// ---- Implementer ----
			if (issue.skipImplementer) {
				logger?.info({ issueId: issue.id }, "Skip implementer — resuming from review phase");
			} else {
				await labelCallbacks?.onImplementStart?.(issue.id);
				lastPhaseLabel = EXECUTING;

				implementResult = await sandbox.run({
					name: "implementer",
					maxIterations: 100,
					agent: pi("opencode-go/deepseek-v4-flash"),
					promptFile: "./.sandcastle/prompts/implement.md",
					promptArgs: {
						TASK_ID: issue.id,
						ISSUE_TITLE: issue.title,
						BRANCH: issue.branch,
					},
					resumeSession: issue.implementSession,
				});

				// Capture implementer session
				const implementSessionId = implementResult.iterations[0]?.sessionId;
				await labelCallbacks?.onImplementSession?.(issue.id, implementSessionId);
			}

			// ---- Reviewer (only if implementer produced commits or was skipped) ----
			// When skipImplementer, we assume prior commits exist (the issue was already
			// mid-review). If there are truly no commits, the merge phase will skip this issue.
			const hasCommits = issue.skipImplementer || (implementResult?.commits.length ?? 0) > 0;

			let reviewResult: SandboxRunResult | undefined;

			if (hasCommits) {
				// Run Biome linter + formatter on the implementer's changes.
				// Skip if implementer was skipped (changes were already linted).
				if (implementResult) {
					try {
						await $`pnpm check`.quiet();
					} catch (biomeErr) {
						// Non-fatal: the reviewer may still catch style issues.
						logger?.warn(
							{ err: biomeErr, issueId: issue.id },
							"Biome check failed — continuing to reviewer",
						);
					}
				}

				await labelCallbacks?.onReviewStart?.(issue.id);
				lastPhaseLabel = REVIEWING;

				reviewResult = await sandbox.run({
					name: "reviewer",
					maxIterations: 1,
					agent: pi("opencode-go/deepseek-v4-pro"),
					promptFile: "./.sandcastle/prompts/review.md",
					promptArgs: { BRANCH: issue.branch },
					resumeSession: issue.reviewSession,
				});

				// Capture reviewer session
				const reviewSessionId = reviewResult.iterations[0]?.sessionId;
				await labelCallbacks?.onReviewSession?.(issue.id, reviewSessionId);
			}

			// Both paths: mark as executed and run post-execute hook
			await labelCallbacks?.onExecuteComplete?.(issue.id);
			lastPhaseLabel = EXECUTED;
			await runPhaseHook(issue.id, "post_execute", logger);

			if (hasCommits && reviewResult) {
				const implementCommits = implementResult?.commits ?? [];
				return {
					...reviewResult,
					commits: [...implementCommits, ...reviewResult.commits],
				};
			}

			// implementResult is always defined at this point because:
			// - if skipImplementer=true, hasCommits evaluates to true and we return early above
			// - if skipImplementer=false, implementResult was set by sandbox.run()
			// The guard exists only for TypeScript narrowing — at runtime it's never reached.
			/* v8 ignore next 3 */
			if (!implementResult) {
				return { stdout: "", commits: [], iterations: [], logFilePath: undefined };
			}

			return implementResult;
		} catch (err) {
			// Revert phase label on crash so the issue reappears at the right
			// point on next sandcastle startup.
			if (lastPhaseLabel) {
				try {
					await labelCallbacks?.onCrash?.(issue.id, lastPhaseLabel);
				} catch (revertErr) {
					// Non-fatal: don't mask the original error
					logger?.error(
						{ err: revertErr, issueId: issue.id },
						"Label revert callback failed — continuing with original error",
					);
				}
			}
			throw err;
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
				notifier
					?.send({
						level: "error",
						title: `Execute failed: ${issue.id}`,
						message: `Issue ${issue.id} (${issue.branch}) failed during execution: ${formatErrorMessage(outcome.reason)}`,
						tags: ["execute", "sandcastle", "error"],
					})
					.catch(() => {});
			}
		}
	}

	const completedIssues = settled.flatMap((outcome, i) => {
		const issue = issues[i];
		if (outcome.status === "fulfilled" && issue) {
			// When skipping implementer, the branch already has commits from a
			// prior run. The resume reviewer may produce 0 new commits, but the
			// issue should still proceed to merge.
			if (issue.skipImplementer) return [issue];
			if (outcome.value.commits.length > 0) return [issue];
		}
		return [];
	});

	return completedIssues;
}
