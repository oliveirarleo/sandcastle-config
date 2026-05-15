import type {
	SandboxHooks,
	SandboxProvider,
	SandboxRunOptions,
	SandboxRunResult,
} from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";
import type { PlannerIssue } from "../types.mts";
import { type CreateSandboxFn, type ExecuteLabelCallbacks, runExecutionPhase } from "./execute.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_SANDBOX = {} as unknown as SandboxProvider;
const NOOP_HOOKS = {} as unknown as SandboxHooks;

interface RunCapture {
	name?: string;
	resumeSession?: string;
}

function mockRunResult(
	commits: { sha: string }[] = [{ sha: "abc123" }],
	sessionId?: string,
): SandboxRunResult {
	return {
		stdout: "",
		commits,
		iterations: sessionId ? [{ sessionId }] : [],
		logFilePath: undefined,
	};
}

function mockSandboxWithCapture(): {
	sandbox: ReturnType<typeof mockSandbox>;
	runs: RunCapture[];
} {
	const runs: RunCapture[] = [];
	const sandbox = mockSandbox(async (opts) => {
		runs.push({ name: opts.name, resumeSession: opts.resumeSession });
		return mockRunResult(
			opts.name === "implementer" ? [{ sha: "abc" }] : [],
			`session-${opts.name}`,
		);
	});
	return { sandbox, runs };
}

function mockSandbox(
	runImpl: (opts: SandboxRunOptions) => Promise<SandboxRunResult> = async () => mockRunResult(),
) {
	let closed = false;
	return {
		run: runImpl,
		close: async () => {
			closed = true;
		},
		get closed() {
			return closed;
		},
	};
}

function sandboxWithCloseTracker(
	runImpl?: (opts: SandboxRunOptions) => Promise<SandboxRunResult>,
): { createSandbox: CreateSandboxFn; wasClosed: () => boolean } {
	let closed = false;
	const createSandbox: CreateSandboxFn = async () => {
		const sb = mockSandbox(runImpl);
		const originalClose = sb.close;
		sb.close = async () => {
			closed = true;
			await originalClose();
		};
		return sb;
	};
	return { createSandbox, wasClosed: () => closed };
}

describe("runExecutionPhase", () => {
	it("completes a single issue when implementer produces commits", async () => {
		const issues: PlannerIssue[] = [{ id: "issue-1", title: "Fix A", branch: "branch-a" }];

		const createSandbox: CreateSandboxFn = async () => mockSandbox();

		const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 3);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("issue-1");
	});

	it("does not complete issue when implementer produces no commits", async () => {
		const issues: PlannerIssue[] = [{ id: "issue-1", title: "Fix A", branch: "branch-a" }];

		let runCount = 0;
		const createSandbox: CreateSandboxFn = async () =>
			mockSandbox(async () => {
				runCount++;
				return mockRunResult([]);
			});

		const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 3);

		expect(result).toHaveLength(0);
		expect(runCount).toBe(1);
	});

	it("runs reviewer after implementer with commits", async () => {
		const issues: PlannerIssue[] = [{ id: "issue-1", title: "Fix A", branch: "branch-a" }];

		const runNames: string[] = [];
		const createSandbox: CreateSandboxFn = async () =>
			mockSandbox(async (opts) => {
				runNames.push(opts.name ?? "unknown");
				return mockRunResult(opts.name === "implementer" ? [{ sha: "abc" }] : []);
			});

		const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 3);

		expect(result).toHaveLength(1);
		expect(runNames).toEqual(["implementer", "reviewer"]);
	});

	it("processes multiple issues concurrently", async () => {
		const issues: PlannerIssue[] = [
			{ id: "issue-1", title: "Fix A", branch: "branch-a" },
			{ id: "issue-2", title: "Fix B", branch: "branch-b" },
		];

		const processed: string[] = [];
		const createSandbox: CreateSandboxFn = async (_opts) => {
			return mockSandbox(async (runOpts) => {
				processed.push(runOpts.name ?? "unknown");
				return mockRunResult([{ sha: String(runOpts.promptArgs?.BRANCH ?? "unknown") }]);
			});
		};

		const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 2);

		expect(result).toHaveLength(2);
		expect(processed).toHaveLength(4);
	});

	it("does not crash other issues when one fails", async () => {
		const issues: PlannerIssue[] = [
			{ id: "issue-1", title: "Fix A", branch: "branch-a" },
			{ id: "issue-2", title: "Fix B", branch: "branch-b" },
		];

		const createSandbox: CreateSandboxFn = async (opts) => {
			if (opts.branch === "branch-a") {
				throw new Error("sandbox creation failed");
			}
			return mockSandbox();
		};

		const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 2);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("issue-2");
	});

	it("closes sandbox after each issue", async () => {
		const { createSandbox, wasClosed } = sandboxWithCloseTracker();

		await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			createSandbox,
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
		);

		expect(wasClosed()).toBe(true);
	});

	it("closes sandbox even after implementer crash", async () => {
		const { createSandbox, wasClosed } = sandboxWithCloseTracker(async () => {
			throw new Error("implementer crashed");
		});

		const result = await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			createSandbox,
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
		);

		expect(result).toHaveLength(0);
		expect(wasClosed()).toBe(true);
	});

	it("calls onImplementStart when implementer begins", async () => {
		const calls: string[] = [];
		const callbacks = {
			onImplementStart: (issueId: string) => {
				calls.push(`implement:${issueId}`);
				return Promise.resolve();
			},
		};

		await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			async () => mockSandbox(),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
			undefined,
			callbacks,
		);

		expect(calls).toEqual(["implement:issue-1"]);
	});

	it("calls onReviewStart when reviewer begins", async () => {
		const calls: string[] = [];
		const callbacks = {
			onReviewStart: (issueId: string) => {
				calls.push(`review:${issueId}`);
				return Promise.resolve();
			},
		};

		await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			async () => mockSandbox(),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
			undefined,
			callbacks,
		);

		expect(calls).toEqual(["review:issue-1"]);
	});

	it("calls onExecuteComplete after implement + review complete", async () => {
		const calls: string[] = [];
		const callbacks = {
			onExecuteComplete: (issueId: string) => {
				calls.push(`complete:${issueId}`);
				return Promise.resolve();
			},
		};

		const result = await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			async () => mockSandbox(),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
			undefined,
			callbacks,
		);

		expect(result).toHaveLength(1);
		expect(calls).toEqual(["complete:issue-1"]);
	});

	it("calls onExecuteComplete when implementer produces no commits (zero-commit → executed)", async () => {
		const calls: string[] = [];
		const callbacks = {
			onExecuteComplete: (issueId: string) => {
				calls.push(`complete:${issueId}`);
				return Promise.resolve();
			},
		};

		const result = await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			async () => mockSandbox(async () => mockRunResult([])),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
			undefined,
			callbacks,
		);

		// Issue not returned as completed (nothing to merge) but label still advances
		expect(result).toHaveLength(0);
		expect(calls).toEqual(["complete:issue-1"]);
	});

	it("does not call onReviewStart when implementer produces no commits (zero-commit)", async () => {
		const reviewCalls: string[] = [];
		const callbacks = {
			onReviewStart: (issueId: string) => {
				reviewCalls.push(`review:${issueId}`);
				return Promise.resolve();
			},
		};

		await runExecutionPhase(
			[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
			async () => mockSandbox(async () => mockRunResult([])),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			[],
			3,
			undefined,
			callbacks,
		);

		// No reviewer label should be set for zero-commit issues
		expect(reviewCalls).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// Resume tests
	// -----------------------------------------------------------------------

	describe("resume", () => {
		it("passes no resumeSession for fresh issue (backward compatible)", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();

			await runExecutionPhase(
				[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
			);

			const implementRun = runs.find((r) => r.name === "implementer");
			expect(implementRun?.resumeSession).toBeUndefined();
		});

		it("passes resumeSession to implementer when implementSession is set", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();

			await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						implementSession: "ses-implement-abc",
					},
				],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
			);

			const implementRun = runs.find((r) => r.name === "implementer");
			expect(implementRun?.resumeSession).toBe("ses-implement-abc");
		});

		it("passes resumeSession to reviewer when reviewSession is set", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();

			await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						reviewSession: "ses-review-xyz",
					},
				],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
			);

			const reviewRun = runs.find((r) => r.name === "reviewer");
			expect(reviewRun?.resumeSession).toBe("ses-review-xyz");
		});

		it("skips implementer when skipImplementer is true", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();

			await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						skipImplementer: true,
					},
				],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
			);

			const implementRun = runs.find((r) => r.name === "implementer");
			expect(implementRun).toBeUndefined();
			const reviewRun = runs.find((r) => r.name === "reviewer");
			expect(reviewRun).toBeDefined();
		});

		it("skips implementer and resumes reviewer when skipImplementer + reviewSession", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();

			await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						skipImplementer: true,
						reviewSession: "ses-review-xyz",
					},
				],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
			);

			const implementRun = runs.find((r) => r.name === "implementer");
			expect(implementRun).toBeUndefined();
			const reviewRun = runs.find((r) => r.name === "reviewer");
			expect(reviewRun?.resumeSession).toBe("ses-review-xyz");
		});

		it("calls onImplementSession with session ID after implementer run", async () => {
			const sessions: Array<{ id: string; sessionId?: string }> = [];
			const callbacks: ExecuteLabelCallbacks = {
				onImplementSession: (id, sessionId) => {
					sessions.push({ id, sessionId });
					return Promise.resolve();
				},
			};

			const { sandbox } = mockSandboxWithCapture();

			await runExecutionPhase(
				[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			expect(sessions).toEqual([{ id: "issue-1", sessionId: "session-implementer" }]);
		});

		it("calls onReviewSession with session ID after reviewer run", async () => {
			const sessions: Array<{ id: string; sessionId?: string }> = [];
			const callbacks: ExecuteLabelCallbacks = {
				onReviewSession: (id, sessionId) => {
					sessions.push({ id, sessionId });
					return Promise.resolve();
				},
			};

			const { sandbox } = mockSandboxWithCapture();

			await runExecutionPhase(
				[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			expect(sessions).toEqual([{ id: "issue-1", sessionId: "session-reviewer" }]);
		});

		it("calls onImplementSession with undefined when implementer produces no session", async () => {
			const sessions: Array<{ id: string; sessionId?: string }> = [];
			const callbacks: ExecuteLabelCallbacks = {
				onImplementSession: (id, sessionId) => {
					sessions.push({ id, sessionId });
					return Promise.resolve();
				},
			};

			// Sandbox that returns no session in iterations
			const createSandbox: CreateSandboxFn = async () =>
				mockSandbox(async () => ({
					stdout: "",
					commits: [{ sha: "abc" }],
					iterations: [{}], // no sessionId
					logFilePath: undefined,
				}));

			await runExecutionPhase(
				[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
				createSandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			expect(sessions).toEqual([{ id: "issue-1", sessionId: undefined }]);
		});

		it("calls onReviewSession with undefined when reviewer produces no session", async () => {
			const sessions: Array<{ id: string; sessionId?: string }> = [];
			const callbacks: ExecuteLabelCallbacks = {
				onReviewSession: (id, sessionId) => {
					sessions.push({ id, sessionId });
					return Promise.resolve();
				},
			};

			const createSandbox: CreateSandboxFn = async () =>
				mockSandbox(async (opts) => {
					if (opts.name === "implementer") {
						return mockRunResult([{ sha: "abc" }], "ses-impl");
					}
					// Reviewer returns empty iterations (no session)
					return {
						stdout: "",
						commits: [],
						iterations: [{}],
						logFilePath: undefined,
					};
				});

			await runExecutionPhase(
				[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
				createSandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			expect(sessions).toEqual([{ id: "issue-1", sessionId: undefined }]);
		});

		it("calls onImplementSession before onReviewStart", async () => {
			const order: string[] = [];
			const callbacks: ExecuteLabelCallbacks = {
				onImplementSession: async (id) => {
					order.push(`session:${id}`);
				},
				onReviewStart: async (id) => {
					order.push(`review:${id}`);
				},
			};

			const { sandbox } = mockSandboxWithCapture();

			await runExecutionPhase(
				[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			expect(order).toEqual(["session:issue-1", "review:issue-1"]);
		});

		it("falls back to fresh implementer when session is stale", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();
			const callbacks: ExecuteLabelCallbacks = {
				// Session is stale (file missing)
				onValidateSession: async () => false,
			};

			await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						implementSession: "ses-stale",
					},
				],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			const implementRun = runs.find((r) => r.name === "implementer");
			// Should NOT pass the stale session
			expect(implementRun?.resumeSession).toBeUndefined();
		});

		it("falls back to fresh reviewer when session is stale", async () => {
			const { sandbox, runs } = mockSandboxWithCapture();
			const callbacks: ExecuteLabelCallbacks = {
				onValidateSession: async () => false,
			};

			await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						skipImplementer: true,
						reviewSession: "ses-stale",
					},
				],
				async () => sandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
				undefined,
				callbacks,
			);

			const reviewRun = runs.find((r) => r.name === "reviewer");
			// Should NOT pass the stale session
			expect(reviewRun?.resumeSession).toBeUndefined();
		});

		it("completes issue even when reviewer produces 0 commits (skipImplementer)", async () => {
			// Sandbox that returns no commits for reviewer
			const createSandbox: CreateSandboxFn = async () =>
				mockSandbox(async (opts) => {
					if (opts.name === "implementer") {
						return mockRunResult([{ sha: "abc" }]);
					}
					// Reviewer returns 0 commits
					return mockRunResult([]);
				});

			const result = await runExecutionPhase(
				[
					{
						id: "issue-1",
						title: "Fix A",
						branch: "branch-a",
						skipImplementer: true,
					},
				],
				createSandbox,
				NOOP_SANDBOX,
				NOOP_HOOKS,
				[],
				3,
			);

			// Should still be completed (branch already has commits from prior run)
			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe("issue-1");
		});

		// -----------------------------------------------------------------------
		// Crash revert tests
		// -----------------------------------------------------------------------

		describe("crash revert", () => {
			it("reverts from executing to planned when implementer crashes after onImplementStart", async () => {
				const crashes: string[] = [];
				const callbacks: ExecuteLabelCallbacks = {
					onCrash: async (issueId, currentLabel) => {
						crashes.push(`${issueId}:${currentLabel}`);
					},
				};

				const createSandbox: CreateSandboxFn = async () =>
					mockSandbox(async (opts) => {
						if (opts.name === "implementer") {
							throw new Error("implementer crashed");
						}
						return mockRunResult();
					});

				const result = await runExecutionPhase(
					[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
					createSandbox,
					NOOP_SANDBOX,
					NOOP_HOOKS,
					[],
					3,
					undefined,
					callbacks,
				);

				// Issue should not be completed
				expect(result).toHaveLength(0);
				// Revert should have been triggered from EXECUTING back to PLANNED
				expect(crashes).toEqual(["issue-1:sandcastle:executing"]);
			});

			it("reverts from reviewing to executing when reviewer crashes after onReviewStart", async () => {
				const crashes: string[] = [];
				const callbacks: ExecuteLabelCallbacks = {
					onCrash: async (issueId, currentLabel) => {
						crashes.push(`${issueId}:${currentLabel}`);
					},
				};

				const createSandbox: CreateSandboxFn = async () =>
					mockSandbox(async (opts) => {
						if (opts.name === "implementer") {
							return mockRunResult([{ sha: "abc" }]);
						}
						if (opts.name === "reviewer") {
							throw new Error("reviewer crashed");
						}
						return mockRunResult();
					});

				const result = await runExecutionPhase(
					[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
					createSandbox,
					NOOP_SANDBOX,
					NOOP_HOOKS,
					[],
					3,
					undefined,
					callbacks,
				);

				// Issue should not be completed
				expect(result).toHaveLength(0);
				// Revert should have been triggered from REVIEWING back to EXECUTING
				expect(crashes).toEqual(["issue-1:sandcastle:reviewing"]);
			});

			it("does not trigger revert when sandbox creation fails before any label callbacks", async () => {
				const crashes: string[] = [];
				const callbacks: ExecuteLabelCallbacks = {
					onCrash: async (issueId, currentLabel) => {
						crashes.push(`${issueId}:${currentLabel}`);
					},
				};

				const createSandbox: CreateSandboxFn = async () => {
					throw new Error("sandbox creation failed");
				};

				const result = await runExecutionPhase(
					[{ id: "issue-1", title: "Fix A", branch: "branch-a" }],
					createSandbox,
					NOOP_SANDBOX,
					NOOP_HOOKS,
					[],
					3,
					undefined,
					callbacks,
				);

				expect(result).toHaveLength(0);
				// No crash callback should have been called
				expect(crashes).toEqual([]);
			});

			it("isolates crashes per issue - other issues still complete", async () => {
				const crashes: string[] = [];
				const callbacks: ExecuteLabelCallbacks = {
					onCrash: async (issueId, currentLabel) => {
						crashes.push(`${issueId}:${currentLabel}`);
					},
				};

				const createSandbox: CreateSandboxFn = async (opts) => {
					if (opts.branch === "branch-a") {
						return mockSandbox(async (runOpts) => {
							if (runOpts.name === "implementer") {
								throw new Error("branch-a implementer crashed");
							}
							return mockRunResult();
						});
					}
					return mockSandbox();
				};

				const result = await runExecutionPhase(
					[
						{ id: "issue-1", title: "Fix A", branch: "branch-a" },
						{ id: "issue-2", title: "Fix B", branch: "branch-b" },
					],
					createSandbox,
					NOOP_SANDBOX,
					NOOP_HOOKS,
					[],
					2,
					undefined,
					callbacks,
				);

				// Only branch-b should complete
				expect(result).toHaveLength(1);
				expect(result[0]?.id).toBe("issue-2");
				// Branch-a should have triggered a revert
				expect(crashes).toEqual(["issue-1:sandcastle:executing"]);
			});

			// -----------------------------------------------------------------------
			// AC #7: Integration test — 3 issues in parallel, crash one mid-implementer,
			// assert other 2 land at executed (with EXECUTED label callback)
			// -----------------------------------------------------------------------

			it("3 issues in parallel, one implementer crashes — other 2 reach executed label", async () => {
				const labelTransitions: Array<{ issueId: string; label: string; event: string }> = [];
				const callbacks: ExecuteLabelCallbacks = {
					onImplementStart: async (issueId) => {
						labelTransitions.push({
							issueId,
							label: "sandcastle:executing",
							event: "implementStart",
						});
					},
					onExecuteComplete: async (issueId) => {
						labelTransitions.push({
							issueId,
							label: "sandcastle:executed",
							event: "executeComplete",
						});
					},
					onCrash: async (issueId, currentLabel) => {
						labelTransitions.push({ issueId, label: currentLabel, event: "crash" });
					},
				};

				const createSandbox: CreateSandboxFn = async (opts) => {
					if (opts.branch === "branch-b") {
						// issue-2 (branch-b) crashes during implementer
						return mockSandbox(async (runOpts) => {
							if (runOpts.name === "implementer") {
								throw new Error("issue-2 implementer crashed");
							}
							return mockRunResult();
						});
					}
					// All other issues complete normally
					return mockSandbox();
				};

				const result = await runExecutionPhase(
					[
						{ id: "issue-1", title: "Fix A", branch: "branch-a" },
						{ id: "issue-2", title: "Fix B", branch: "branch-b" },
						{ id: "issue-3", title: "Fix C", branch: "branch-c" },
					],
					createSandbox,
					NOOP_SANDBOX,
					NOOP_HOOKS,
					[],
					3,
					undefined,
					callbacks,
				);

				// 2 issues should complete (issue-1 and issue-3)
				expect(result).toHaveLength(2);
				const completedIds = result.map((r) => r.id).sort();
				expect(completedIds).toEqual(["issue-1", "issue-3"]);

				// issue-2 should have crashed with implementing label
				const crashEvents = labelTransitions.filter((t) => t.event === "crash");
				expect(crashEvents).toHaveLength(1);
				expect(crashEvents[0]?.issueId).toBe("issue-2");
				expect(crashEvents[0]?.label).toBe("sandcastle:executing");

				// issue-1 and issue-3 should both have reached executed
				const executedEvents = labelTransitions.filter(
					(t) => t.event === "executeComplete" && t.label === "sandcastle:executed",
				);
				expect(executedEvents).toHaveLength(2);
				const executedIds = executedEvents.map((t) => t.issueId).sort();
				expect(executedIds).toEqual(["issue-1", "issue-3"]);
			});
		});
	});
});
