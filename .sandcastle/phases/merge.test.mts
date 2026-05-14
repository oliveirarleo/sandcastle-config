import assert from "assert";
import { runMergePhase, type MergeableIssue } from "./merge.mts";

const calls: any[] = [];

async function mockRunSandbox(args: any): Promise<any> {
  calls.push(args);
  return { stdout: "", commits: [] };
}

const issues: MergeableIssue[] = [
  { branch: "branch-a", id: "issue-1", title: "Fix A" },
  { branch: "branch-b", id: "issue-2", title: "Fix B" },
];

await runMergePhase(mockRunSandbox, issues, {}, {});

assert.strictEqual(calls.length, 2, "should call sandcastle.run once per issue");
assert.strictEqual(calls[0].promptArgs.BRANCHES, "- branch-a", "first call should merge branch-a");
assert.strictEqual(calls[1].promptArgs.BRANCHES, "- branch-b", "second call should merge branch-b");
assert.strictEqual(calls[0].promptArgs.ISSUES, "- issue-1: Fix A", "first call should reference issue-1");
assert.strictEqual(calls[1].promptArgs.ISSUES, "- issue-2: Fix B", "second call should reference issue-2");

console.log("All merge phase tests passed!");
