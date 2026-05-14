import assert from "assert";
import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { runMergePhase } from "./merge.mts";
import type { PlannerIssue } from "../types.mts";

const calls: RunOptions[] = [];

async function mockRunSandbox(options: RunOptions): Promise<RunResult> {
  calls.push(options);
  return { stdout: "", commits: [], iterations: [], branch: "main" };
}

const issues: PlannerIssue[] = [
  { branch: "branch-a", id: "issue-1", title: "Fix A" },
  { branch: "branch-b", id: "issue-2", title: "Fix B" },
];

await runMergePhase(
  mockRunSandbox,
  issues,
  {} as unknown as SandboxProvider,
  {} as unknown as SandboxHooks,
  undefined,
);

assert.strictEqual(calls.length, 2, "should call sandcastle.run once per issue");
assert.strictEqual(calls[0]!.promptArgs!.BRANCHES, "- branch-a", "first call should merge branch-a");
assert.strictEqual(calls[1]!.promptArgs!.BRANCHES, "- branch-b", "second call should merge branch-b");
assert.strictEqual(calls[0]!.promptArgs!.ISSUES, "- issue-1: Fix A", "first call should reference issue-1");
assert.strictEqual(calls[1]!.promptArgs!.ISSUES, "- issue-2: Fix B", "second call should reference issue-2");
assert.deepStrictEqual(
  calls[0]!.branchStrategy,
  { type: "merge-to-head" },
  "should use merge-to-head branch strategy",
);
assert.deepStrictEqual(
  calls[1]!.branchStrategy,
  { type: "merge-to-head" },
  "should use merge-to-head branch strategy for all issues",
);

console.log("All merge phase tests passed!");
