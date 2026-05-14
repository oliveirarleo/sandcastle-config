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
});
