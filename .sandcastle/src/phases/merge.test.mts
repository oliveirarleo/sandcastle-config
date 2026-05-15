import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { describe, expect, it, vi } from "vitest";
import type { Notifier } from "../helpers/notifier.mts";
import type { PlannerIssue } from "../types.mts";
import { isBranchMerged, runMergePhase } from "./merge.mts";

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
