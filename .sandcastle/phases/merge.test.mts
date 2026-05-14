import assert from "assert";
import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { runMergePhase } from "./merge.mts";
import type { PlannerIssue } from "../types.mts";

// ---------------------------------------------------------------------------
// Happy path: all branches merged sequentially
// ---------------------------------------------------------------------------

{
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
}

// ---------------------------------------------------------------------------
// Per-branch error isolation: one failing merge does not block remaining branches
// ---------------------------------------------------------------------------

{
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

  await runMergePhase(
    mockRunWithFailure,
    threeIssues,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    undefined,
  );

  assert.strictEqual(isolatedCalls.length, 3, "should attempt all three merges despite one failure");
  assert.strictEqual(isolatedCalls[0], "- branch-a", "first branch should be attempted");
  assert.strictEqual(isolatedCalls[1], "- branch-b", "second (failing) branch should be attempted");
  assert.strictEqual(isolatedCalls[2], "- branch-c", "third branch should still be attempted after failure");
}

// ---------------------------------------------------------------------------
// All merges fail: does not throw, completes silently
// ---------------------------------------------------------------------------

{
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
  await runMergePhase(
    mockAlwaysFail,
    issues,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    undefined,
  );

  assert.strictEqual(failingCalls.length, 2, "should attempt all merges even when all fail");
}

console.log("All merge phase tests passed!");
