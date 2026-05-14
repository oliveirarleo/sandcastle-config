import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";
import type { PlannerIssue } from "../types.mts";
import { runMergePhase } from "./merge.mts";

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
});
