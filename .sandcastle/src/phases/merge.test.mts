import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { describe, expect, it, vi } from "vitest";
import { MERGED } from "../helpers/labels.mts";
import type { PhaseHook, PhaseHooks } from "../helpers/phase-hooks.mts";
import type { PlannerIssue } from "../types.mts";
import { isBranchMerged, isIssueClosed, runMergePhase, verifyMergedIssues } from "./merge.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_SANDBOX = {} as unknown as SandboxProvider;
const NOOP_HOOKS = {} as unknown as SandboxHooks;

describe("runMergePhase", () => {
	it("calls sandcastle.run once per issue with correct arguments", async () => {
		const calls: RunOptions[] = [];

		async function mockRunSandbox(options: RunOptions): Promise<RunResult> {
			calls.push(options);
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		const issues: PlannerIssue[] = [
			{ branch: "branch-a", id: "issue-1", title: "Fix A" },
			{ branch: "branch-b", id: "issue-2", title: "Fix B" },
		];

		await runMergePhase(mockRunSandbox, issues, NOOP_SANDBOX, NOOP_HOOKS);

		expect(calls).toHaveLength(2);
		expect(calls[0]?.promptArgs?.BRANCHES).toBe("- branch-a");
		expect(calls[1]?.promptArgs?.BRANCHES).toBe("- branch-b");
		expect(calls[0]?.promptArgs?.ISSUES).toBe("- issue-1: Fix A");
		expect(calls[1]?.promptArgs?.ISSUES).toBe("- issue-2: Fix B");
		expect(calls[0]?.branchStrategy).toEqual({ type: "merge-to-head" });
		expect(calls[1]?.branchStrategy).toEqual({ type: "merge-to-head" });
	});

	it("isolates per-branch errors: one failing merge does not block remaining branches", async () => {
		vi.setConfig({ testTimeout: 30_000 });
		const isolatedCalls: string[] = [];

		async function mockRunWithFailure(opts: RunOptions): Promise<RunResult> {
			const branch = opts.promptArgs?.BRANCHES as string;
			isolatedCalls.push(branch);
			if (branch === "- branch-b") {
				throw new Error("merge conflict on branch-b");
			}
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		const threeIssues: PlannerIssue[] = [
			{ branch: "branch-a", id: "issue-1", title: "Fix A" },
			{ branch: "branch-b", id: "issue-2", title: "Fix B" },
			{ branch: "branch-c", id: "issue-3", title: "Fix C" },
		];

		await runMergePhase(mockRunWithFailure, threeIssues, NOOP_SANDBOX, NOOP_HOOKS);

		expect(isolatedCalls).toHaveLength(3);
		expect(isolatedCalls[0]).toBe("- branch-a");
		expect(isolatedCalls[1]).toBe("- branch-b");
		expect(isolatedCalls[2]).toBe("- branch-c");
	});

	it("does not throw when all merges fail", async () => {
		const failingCalls: string[] = [];

		async function mockAlwaysFail(opts: RunOptions): Promise<RunResult> {
			failingCalls.push(opts.promptArgs?.BRANCHES as string);
			throw new Error("merge failed");
		}

		const issues: PlannerIssue[] = [
			{ branch: "branch-a", id: "issue-1", title: "Fix A" },
			{ branch: "branch-b", id: "issue-2", title: "Fix B" },
		];

		// Should not throw
		await expect(
			runMergePhase(mockAlwaysFail, issues, NOOP_SANDBOX, NOOP_HOOKS),
		).resolves.toBeUndefined();

		expect(failingCalls).toHaveLength(2);
	});

	it("calls onMergeComplete callback after successful merge", async () => {
		const completed: string[] = [];
		const onMergeComplete = (issueId: string) => {
			completed.push(issueId);
			return Promise.resolve();
		};

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

	});
});

// -----------------------------------------------------------------------
// Function-based hook tests
// -----------------------------------------------------------------------

describe("runMergePhase hooks", () => {
	it("calls onPreMerge before merge action", async () => {
		const order: string[] = [];
		const hooks: PhaseHooks = {
			onPreMerge: [
				async ({ issueId, branch }) => {
					order.push(`pre:${issueId}:${branch}`);
				},
			],
		};

		const runCalls: string[] = [];
		async function mockRunSandbox(opts: RunOptions): Promise<RunResult> {
			runCalls.push(opts.promptArgs?.BRANCHES as string);
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await runMergePhase(
			mockRunSandbox,
			[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			hooks,
		);

		// Hook ran before merge
		expect(order).toEqual(["pre:issue-1:branch-a"]);
		expect(runCalls).toHaveLength(1);
	});

	it("calls onPostMerge with error when merge fails", async () => {
		const errors: Array<{ id?: string; msg?: string }> = [];
		const hooks: PhaseHooks = {
			onPostMerge: [
				async ({ issueId, error }) => {
					errors.push({ id: issueId, msg: (error as Error)?.message });
				},
			],
		};

		async function mockRunFails(_opts: RunOptions): Promise<RunResult> {
			throw new Error("merge conflict");
		}

		await runMergePhase(
			mockRunFails,
			[{ branch: "branch-b", id: "issue-2", title: "Fix B" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			hooks,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0]?.id).toBe("issue-2");
		expect(errors[0]?.msg).toContain("merge conflict");
	});

	it("calls onPostMerge without error when merge succeeds", async () => {
		const results: Array<{ id: string; hasError: boolean }> = [];
		const hooks: PhaseHooks = {
			onPostMerge: [
				async ({ issueId, error }) => {
					results.push({ id: issueId ?? "unknown", hasError: error !== undefined });
				},
			],
		};

		async function mockRunSucceeded(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await runMergePhase(
			mockRunSucceeded,
			[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			hooks,
		);

		expect(results).toEqual([{ id: "issue-1", hasError: false }]);
	});

	it("onPostMerge runs for all issues even when some fail", async () => {
		const postMergeCalls: string[] = [];
		const hooks: PhaseHooks = {
			onPostMerge: [
				async ({ issueId, error }) => {
					postMergeCalls.push(`${issueId}:${error ? "err" : "ok"}`);
				},
			],
		};

		async function mockRunSandbox(opts: RunOptions): Promise<RunResult> {
			if (opts.promptArgs?.BRANCHES === "- branch-b") {
				throw new Error("merge conflict on branch-b");
			}
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await runMergePhase(
			mockRunSandbox,
			[
				{ branch: "branch-a", id: "issue-1", title: "Fix A" },
				{ branch: "branch-b", id: "issue-2", title: "Fix B" },
				{ branch: "branch-c", id: "issue-3", title: "Fix C" },
			],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			hooks,
		);

		// All 3 issues should trigger onPostMerge (2 success, 1 error)
		expect(postMergeCalls).toEqual(["issue-1:ok", "issue-2:err", "issue-3:ok"]);
	});

	it("runs multiple hooks in onPostMerge", async () => {
		const order: string[] = [];
		const hooks: PhaseHooks = {
			onPostMerge: [
				async () => {
					order.push("post-merge-a");
				},
				async () => {
					order.push("post-merge-b");
				},
			],
		};

		async function mockRunSucceeded(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await runMergePhase(
			mockRunSucceeded,
			[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			hooks,
		);

		expect(order).toEqual(["post-merge-a", "post-merge-b"]);
	});
});

describe("verifyMergedIssues", () => {
	it("returns empty array when no merged issues provided", async () => {
		const result = await verifyMergedIssues([]);
		expect(result).toEqual([]);
	});

	it("does nothing when branch is merged and ticket is closed", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");

		const issues: PlannerIssue[] = [{ id: "issue-1", title: "Fix A", branch: "branch-a" }];

		// Mock isBranchMerged to return true
		const mergedDep = async () => ({
			stdout: "  branch-a\n  main\n",
			stderr: "",
		});
		// Mock isIssueClosed to return true (status: closed)
		const closedDep = async () => ({
			stdout: JSON.stringify({ data: [{ status: "closed" }] }),
			stderr: "",
		});

		const result = await verifyMergedIssues(issues, {
			isBranchMergedFn: mergedDep,
			isIssueClosedFn: closedDep,
			exec,
		});

		expect(result).toEqual([]);
		expect(exec).not.toHaveBeenCalled();
	});

	it("closes ticket via bd close when branch merged but ticket open", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");

		const issues: PlannerIssue[] = [{ id: "issue-1", title: "Fix A", branch: "branch-a" }];

		// Mock isBranchMerged to return true
		const mergedDep = async () => ({
			stdout: "  branch-a\n  main\n",
			stderr: "",
		});
		// Mock isIssueClosed to return false (ticket still open)
		const closedDep = async () => ({
			stdout: JSON.stringify({ data: [{ status: "open" }] }),
			stderr: "",
		});

		const result = await verifyMergedIssues(issues, {
			isBranchMergedFn: mergedDep,
			isIssueClosedFn: closedDep,
			exec,
		});

		expect(result).toEqual([]);
		expect(exec).toHaveBeenCalledWith(expect.stringContaining('bd close "issue-1"'));
	});

	it("reverts label and returns issue when branch not merged", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");

		const issues: PlannerIssue[] = [{ id: "issue-1", title: "Fix A", branch: "branch-a" }];

		// Mock isBranchMerged to return false
		const mergedDep = async () => ({
			stdout: "  main\n",
			stderr: "",
		});

		const result = await verifyMergedIssues(issues, {
			isBranchMergedFn: mergedDep,
			exec,
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("issue-1");
		// Should remove merged label and add executed label
		expect(exec).toHaveBeenCalledWith(`bd label remove "issue-1" ${MERGED}`);
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" sandcastle:executed`);
	});

	it("error in one issue's label commands does not block processing others", async () => {
		const issues: PlannerIssue[] = [
			{ id: "issue-1", title: "Fix A", branch: "branch-a" },
			{ id: "issue-2", title: "Fix B", branch: "branch-b" },
		];

		// exec fails on first call (issue-1), succeeds on rest
		let execCall = 0;
		const exec = vi.fn<(cmd: string) => Promise<string>>(async () => {
			execCall++;
			if (execCall === 1) throw new Error("label remove failed");
			return "";
		});

		const mergedDep = async () => ({ stdout: "  main\n", stderr: "" });

		const result = await verifyMergedIssues(issues, {
			isBranchMergedFn: mergedDep,
			exec,
		});

		// Only issue-2 was successfully reverted (issue-1's label command failed)
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("issue-2");
	});

	it("partially reverts: one branch merged, one not", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");

		const issues: PlannerIssue[] = [
			{ id: "issue-1", title: "Fix A", branch: "branch-a" },
			{ id: "issue-2", title: "Fix B", branch: "branch-b" },
		];

		let callCount = 0;
		const mergedDep = async () => {
			callCount++;
			if (callCount === 1) return { stdout: "  branch-a\n  main\n", stderr: "" }; // merged
			return { stdout: "  main\n", stderr: "" }; // not merged
		};

		const closedDep = async () => ({
			stdout: JSON.stringify({ data: [{ status: "closed" }] }),
			stderr: "",
		});

		const result = await verifyMergedIssues(issues, {
			isBranchMergedFn: mergedDep,
			isIssueClosedFn: closedDep,
			exec,
		});

		// Only issue-2 was reverted
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("issue-2");
	});
});

describe("isIssueClosed", () => {
	it("returns true when status is closed", async () => {
		const result = await isIssueClosed("issue-1", async () => ({
			stdout: JSON.stringify({ data: [{ status: "closed" }] }),
			stderr: "",
		}));
		expect(result).toBe(true);
	});

	it("returns false when status is open", async () => {
		const result = await isIssueClosed("issue-1", async () => ({
			stdout: JSON.stringify({ data: [{ status: "open" }] }),
			stderr: "",
		}));
		expect(result).toBe(false);
	});

	it("returns false when bd show fails", async () => {
		const result = await isIssueClosed("issue-1", async () => {
			throw new Error("bd show failed");
		});
		expect(result).toBe(false);
	});

	it("returns false on unparseable JSON", async () => {
		const result = await isIssueClosed("issue-1", async () => ({
			stdout: "not json",
			stderr: "",
		}));
		expect(result).toBe(false);
	});
});

describe("isBranchMerged", () => {
	it("returns true when branch is listed in --merged output", async () => {
		const result = await isBranchMerged("main", async () => ({
			stdout: "  main\n* current-branch\n  feature-branch\n",
			stderr: "",
		}));
		expect(result).toBe(true);
	});

	it("returns true for another branch listed in --merged output", async () => {
		const result = await isBranchMerged("feature-branch", async () => ({
			stdout: "  main\n* current\n  feature-branch\n",
			stderr: "",
		}));
		expect(result).toBe(true);
	});

	it("returns false when git command fails", async () => {
		const result = await isBranchMerged("any-branch", async () => {
			throw new Error("git failed");
		});
		expect(result).toBe(false);
	});

	it("returns false for empty stdout", async () => {
		const result = await isBranchMerged("any-branch", async () => ({
			stdout: "",
			stderr: "",
		}));
		expect(result).toBe(false);
	});

	it("returns false when branch not in --merged output", async () => {
		const result = await isBranchMerged("missing-branch", async () => ({
			stdout: "  main\n* current\n  feature-branch\n",
			stderr: "",
		}));
		expect(result).toBe(false);
	});
});

