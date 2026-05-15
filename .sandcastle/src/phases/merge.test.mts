import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MERGED } from "../helpers/labels.mts";
import type { Notifier } from "../helpers/notifier.mts";
import type { PlannerIssue } from "../types.mts";
import { isBranchMerged, isIssueClosed, runMergePhase, verifyMergedIssues } from "./merge.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockNotifier(): Notifier & { send: ReturnType<typeof vi.fn> } {
	return { send: vi.fn().mockResolvedValue(undefined) };
}

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

		await runMergePhase(mockRunSandbox, issues, NOOP_SANDBOX, NOOP_HOOKS, undefined);

		expect(calls).toHaveLength(2);
		expect(calls[0]?.promptArgs?.BRANCHES).toBe("- branch-a");
		expect(calls[1]?.promptArgs?.BRANCHES).toBe("- branch-b");
		expect(calls[0]?.promptArgs?.ISSUES).toBe("- issue-1: Fix A");
		expect(calls[1]?.promptArgs?.ISSUES).toBe("- issue-2: Fix B");
		expect(calls[0]?.branchStrategy).toEqual({ type: "merge-to-head" });
		expect(calls[1]?.branchStrategy).toEqual({ type: "merge-to-head" });
	});

	it("isolates per-branch errors: one failing merge does not block remaining branches", async () => {
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

		await runMergePhase(mockRunWithFailure, threeIssues, NOOP_SANDBOX, NOOP_HOOKS, undefined);

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
			runMergePhase(mockAlwaysFail, issues, NOOP_SANDBOX, NOOP_HOOKS, undefined),
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

		await runMergePhase(
			mockRunSandbox,
			[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			onMergeComplete,
		);

		expect(completed).toEqual(["issue-1"]);
	});

	it("does not call onMergeComplete when merge fails", async () => {
		const completed: string[] = [];
		const onMergeComplete = (issueId: string) => {
			completed.push(issueId);
			return Promise.resolve();
		};

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			throw new Error("merge conflict");
		}

		await runMergePhase(
			mockRunSandbox,
			[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			onMergeComplete,
		);

		expect(completed).toEqual([]);
	});
});

describe("notifier integration", () => {
	it("sends info notification after successful merge", async () => {
		const notif = mockNotifier();

		async function mockRunSucceeded(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await runMergePhase(
			mockRunSucceeded,
			[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			undefined,
			notif,
		);

		expect(notif.send).toHaveBeenCalledTimes(1);
		expect(notif.send).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "info",
				title: expect.stringContaining("branch-a"),
				tags: ["merge", "sandcastle"],
			}),
		);
	});

	it("sends warn notification on merge failure", async () => {
		const notif = mockNotifier();

		async function mockRunFails(_opts: RunOptions): Promise<RunResult> {
			throw new Error("merge conflict");
		}

		await runMergePhase(
			mockRunFails,
			[{ branch: "branch-b", id: "issue-2", title: "Fix B" }],
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			undefined,
			notif,
		);

		expect(notif.send).toHaveBeenCalledTimes(1);
		expect(notif.send).toHaveBeenCalledWith(
			expect.objectContaining({
				level: "warn",
				title: expect.stringContaining("branch-b"),
				tags: ["merge", "sandcastle", "error"],
			}),
		);
	});

	it("notifier failure does not crash merge phase", async () => {
		const notif: Notifier = {
			send: vi.fn().mockRejectedValue(new Error("notifier crash")),
		};

		async function mockRunSucceeded(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await expect(
			runMergePhase(
				mockRunSucceeded,
				[{ branch: "branch-c", id: "issue-3", title: "Fix C" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
				undefined,
				notif,
			),
		).resolves.toBeUndefined();
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

// -----------------------------------------------------------------------
// Hook integration tests
// -----------------------------------------------------------------------

describe("runMergePhase hooks", () => {
	afterEach(() => {
		delete process.env.SANDCASTLE_PRE_MERGE_HOOK;
		delete process.env.SANDCASTLE_POST_MERGE_HOOK;
	});

	it("runs pre-merge hook before merge action", async () => {
		process.env.SANDCASTLE_PRE_MERGE_HOOK = "echo pre-merge-hook";

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await expect(
			runMergePhase(
				mockRunSandbox,
				[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
			),
		).resolves.toBeUndefined();
	});

	it("runs post-merge hook after merge succeeds", async () => {
		process.env.SANDCASTLE_POST_MERGE_HOOK = "echo post-merge-hook";

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await expect(
			runMergePhase(
				mockRunSandbox,
				[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
			),
		).resolves.toBeUndefined();
	});

	it("pre-merge hook failure logs warning but merge still executes", async () => {
		process.env.SANDCASTLE_PRE_MERGE_HOOK = "false";

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await expect(
			runMergePhase(
				mockRunSandbox,
				[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
			),
		).resolves.toBeUndefined();
	});

	it("post-merge hook failure logs warning but merge result preserved", async () => {
		process.env.SANDCASTLE_POST_MERGE_HOOK = "false";

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await expect(
			runMergePhase(
				mockRunSandbox,
				[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
			),
		).resolves.toBeUndefined();
	});

	it("pre-merge hook + merge crash: hook succeeds, merge fails", async () => {
		// AC: hook success + phase crash
		process.env.SANDCASTLE_PRE_MERGE_HOOK = "echo pre-ok";

		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			throw new Error("merge conflict");
		}

		// Should not throw — merge phase isolates per-branch errors
		await expect(
			runMergePhase(
				mockRunSandbox,
				[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
			),
		).resolves.toBeUndefined();
	});

	it("does not run hooks when not configured", async () => {
		async function mockRunSandbox(_opts: RunOptions): Promise<RunResult> {
			return { stdout: "", commits: [], iterations: [], branch: "main" };
		}

		await expect(
			runMergePhase(
				mockRunSandbox,
				[{ branch: "branch-a", id: "issue-1", title: "Fix A" }],
				NOOP_SANDBOX,
				NOOP_HOOKS,
				undefined,
			),
		).resolves.toBeUndefined();
	});
});
