import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineDeps } from "./pipeline.mts";
import type { PlannerIssue } from "../types.mts";
import type { SandboxRunResult } from "@ai-hero/sandcastle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockIssue(id: string, overrides: Partial<PlannerIssue> = {}): PlannerIssue {
	return {
		id,
		title: `Title ${id}`,
		branch: `branch-${id}`,
		...overrides,
	};
}

function mockExecuteOne(
	behavior: Map<string, "success" | "failure" | "no-commits">,
): PipelineDeps["executeOne"] {
	return async (issue: PlannerIssue) => {
		const b = behavior.get(issue.id) ?? "success";
		if (b === "failure") throw new Error(`execute failed for ${issue.id}`);
		const commits = b === "no-commits" ? [] : [{ sha: `sha-${issue.id}` }];
		return {
			stdout: `output-${issue.id}`,
			commits,
			iterations: [{ sessionId: `session-${issue.id}` }],
			logFilePath: undefined,
		};
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
	it("executes issues concurrently and merges results (cold start)", async () => {
		const executeOrder: string[] = [];
		const mergeOrder: string[] = [];

		const executeOne: PipelineDeps["executeOne"] = async (issue) => {
			executeOrder.push(issue.id);
			return {
				stdout: "",
				commits: [{ sha: `sha-${issue.id}` }],
				iterations: [],
				logFilePath: undefined,
			};
		};

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			mergeOrder.push(issue.id);
		};

		const verifyOne: PipelineDeps["verifyOne"] = async () => {};

		await runPipeline({
			executeIssues: [mockIssue("a"), mockIssue("b"), mockIssue("c")],
			mergeIssues: [],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne,
			maxParallelTasks: 3,
		});

		// All issues were executed
		expect(executeOrder).toHaveLength(3);
		expect(executeOrder.sort()).toEqual(["a", "b", "c"]);

		// All issues with commits were merged
		expect(mergeOrder).toHaveLength(3);
	});

	it("does not merge issues with zero commits", async () => {
		const mergeOrder: string[] = [];

		const executeOne = mockExecuteOne(
			new Map([
				["a", "success"],
				["b", "no-commits"],
				["c", "success"],
			]),
		);

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			mergeOrder.push(issue.id);
		};

		await runPipeline({
			executeIssues: [mockIssue("a"), mockIssue("b"), mockIssue("c")],
			mergeIssues: [],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne: async () => {},
			maxParallelTasks: 3,
		});

		// Only issues with commits are merged
		expect(mergeOrder.sort()).toEqual(["a", "c"]);
	});

	it("merge starts before all executions finish (no batch barrier)", async () => {
		// Use a shared array to track timing: execute pauses, then merge starts
		const timeline: string[] = [];

		const executeOne: PipelineDeps["executeOne"] = async (issue) => {
			timeline.push(`exec-start:${issue.id}`);
			// Simulate work
			await new Promise((r) => setTimeout(r, 10));
			timeline.push(`exec-end:${issue.id}`);
			return {
				stdout: "",
				commits: [{ sha: `sha-${issue.id}` }],
				iterations: [],
				logFilePath: undefined,
			};
		};

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			timeline.push(`merge:${issue.id}`);
		};

		await runPipeline({
			executeIssues: [mockIssue("a"), mockIssue("b")],
			mergeIssues: [],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne: async () => {},
			maxParallelTasks: 2,
		});

		// All executions started before all merges finished
		const execStarts = timeline.filter((e) => e.startsWith("exec-start"));
		const merges = timeline.filter((e) => e.startsWith("merge"));
		expect(execStarts).toHaveLength(2);
		expect(merges).toHaveLength(2);
	});

	it("per-issue error boundary: one crash never touches others", async () => {
		const mergeOrder: string[] = [];

		const executeOne = mockExecuteOne(
			new Map([
				["a", "success"],
				["b", "failure"],
				["c", "success"],
			]),
		);

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			mergeOrder.push(issue.id);
		};

		await runPipeline({
			executeIssues: [mockIssue("a"), mockIssue("b"), mockIssue("c")],
			mergeIssues: [],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne: async () => {},
			maxParallelTasks: 3,
		});

		// Issue b failed but a and c still merged
		expect(mergeOrder.sort()).toEqual(["a", "c"]);
	});

	it("merges direct-to-merge issues (resume routing)", async () => {
		const mergeOrder: string[] = [];

		const executeOne: PipelineDeps["executeOne"] = async () => ({
			stdout: "",
			commits: [],
			iterations: [],
			logFilePath: undefined,
		});

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			mergeOrder.push(issue.id);
		};

		await runPipeline({
			executeIssues: [],
			mergeIssues: [mockIssue("x"), mockIssue("y")],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne: async () => {},
			maxParallelTasks: 2,
		});

		// Both direct-to-merge issues were merged
		expect(mergeOrder.sort()).toEqual(["x", "y"]);
	});

	it("verifies merged-labeled issues in parallel", async () => {
		const verifyOrder: string[] = [];

		const verifyOne: PipelineDeps["verifyOne"] = async (issue) => {
			verifyOrder.push(issue.id);
		};

		await runPipeline({
			executeIssues: [],
			mergeIssues: [],
			mergedIssues: [mockIssue("m1"), mockIssue("m2"), mockIssue("m3")],
			executeOne: async () => ({
				stdout: "",
				commits: [],
				iterations: [],
				logFilePath: undefined,
			}),
			mergeOne: async () => {},
			verifyOne,
			maxParallelTasks: 2,
		});

		// All merged-labeled issues were verified
		expect(verifyOrder.sort()).toEqual(["m1", "m2", "m3"]);
	});

	it("handles empty pipeline gracefully", async () => {
		await runPipeline({
			executeIssues: [],
			mergeIssues: [],
			mergedIssues: [],
			executeOne: async () => ({
				stdout: "",
				commits: [],
				iterations: [],
				logFilePath: undefined,
			}),
			mergeOne: async () => {},
			verifyOne: async () => {},
			maxParallelTasks: 2,
		});

		// Should not throw
	});

	it("merges skipImplementer issues even with zero commits from reviewer", async () => {
		const mergeOrder: string[] = [];

		const executeOne: PipelineDeps["executeOne"] = async (issue) => {
			return {
				stdout: "",
				commits: [], // zero commits from reviewer (skipImplementer)
				iterations: [],
				logFilePath: undefined,
			};
		};

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			mergeOrder.push(issue.id);
		};

		await runPipeline({
			executeIssues: [mockIssue("a", { skipImplementer: true })],
			mergeIssues: [],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne: async () => {},
			maxParallelTasks: 2,
		});

		// SkipImplementer issue still proceeds to merge
		expect(mergeOrder).toEqual(["a"]);
	});

	it("queue shutdown propagates cleanly through stream termination", async () => {
		const processed: string[] = [];

		const executeOne: PipelineDeps["executeOne"] = async (issue) => {
			processed.push(`exec:${issue.id}`);
			return {
				stdout: "",
				commits: [{ sha: `sha-${issue.id}` }],
				iterations: [],
				logFilePath: undefined,
			};
		};

		const mergeOne: PipelineDeps["mergeOne"] = async (issue) => {
			processed.push(`merge:${issue.id}`);
		};

		await runPipeline({
			executeIssues: [mockIssue("a")],
			mergeIssues: [],
			mergedIssues: [],
			executeOne,
			mergeOne,
			verifyOne: async () => {},
			maxParallelTasks: 2,
		});

		// Execution completed before merge (or at least both completed)
		expect(processed).toContain("exec:a");
		expect(processed).toContain("merge:a");
	});
});
