import assert from "assert";
import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { runPlanner } from "./plan.mts";

// ---------------------------------------------------------------------------
// Happy path — valid <plan> with issues
// ---------------------------------------------------------------------------

const calls: RunOptions[] = [];

async function mockRun(planStdout: string): Promise<RunResult> {
  return { stdout: planStdout, commits: [], iterations: [], branch: "main" };
}

const validPlan = JSON.stringify({
  issues: [
    { id: "issue-1", title: "Fix auth bug", branch: "sandcastle/issue-1-fix-auth" },
    { id: "issue-2", title: "Add tests", branch: "sandcastle/issue-2-add-tests" },
  ],
});

const captureRun = (stdout: string) => async (opts: RunOptions): Promise<RunResult> => {
  calls.push(opts);
  return mockRun(stdout);
};

const issues = await runPlanner(
  captureRun(`<plan>${validPlan}</plan>`),
  {} as unknown as SandboxProvider,
  {} as unknown as SandboxHooks,
);

assert.strictEqual(issues.length, 2, "should return two issues");
assert.strictEqual(issues[0]!.id, "issue-1", "first issue id should match");
assert.strictEqual(issues[0]!.title, "Fix auth bug", "first issue title should match");
assert.strictEqual(issues[0]!.branch, "sandcastle/issue-1-fix-auth", "first issue branch should match");
assert.strictEqual(issues[1]!.id, "issue-2", "second issue id should match");
assert.strictEqual(calls.length, 1, "should call runSandbox once");
assert.strictEqual(calls[0]!.name, "planner", "should use planner name");
assert.strictEqual(calls[0]!.maxIterations, 1, "should use 1 max iteration");
assert.strictEqual(calls[0]!.promptFile, "./.sandcastle/plan-prompt.md", "should use plan prompt");

// ---------------------------------------------------------------------------
// Missing <plan> tag throws
// ---------------------------------------------------------------------------
await assert.rejects(
  () =>
    runPlanner(
      async () => mockRun("No plan here"),
      {} as unknown as SandboxProvider,
      {} as unknown as SandboxHooks,
    ),
  /did not produce a <plan> tag/,
  "should throw when <plan> tag is missing",
);

// ---------------------------------------------------------------------------
// Invalid JSON inside <plan> throws
// ---------------------------------------------------------------------------
await assert.rejects(
  () =>
    runPlanner(
      async () => mockRun("<plan>not json</plan>"),
      {} as unknown as SandboxProvider,
      {} as unknown as SandboxHooks,
    ),
  /JSON/,
  "should throw when plan contains invalid JSON",
);

// ---------------------------------------------------------------------------
// Schema validation failure throws
// ---------------------------------------------------------------------------
await assert.rejects(
  () =>
    runPlanner(
      async () => mockRun(`<plan>${JSON.stringify({ issues: [{ id: "only-id" }] })}</plan>`),
      {} as unknown as SandboxProvider,
      {} as unknown as SandboxHooks,
    ),
  /Invalid input/,
  "should throw when plan violates schema",
);

// ---------------------------------------------------------------------------
// Empty issues array is returned as-is
// ---------------------------------------------------------------------------
const emptyPlan = JSON.stringify({ issues: [] });
const empty = await runPlanner(
  async () => mockRun(`<plan>${emptyPlan}</plan>`),
  {} as unknown as SandboxProvider,
  {} as unknown as SandboxHooks,
);

assert.deepStrictEqual(empty, [], "should return empty array for empty plan");

console.log("All plan phase tests passed!");
