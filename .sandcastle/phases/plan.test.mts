import assert from "assert";
import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { runPlanner, extractPlanJson } from "./plan.mts";

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

const captureRun = (stdout: string) => (opts: RunOptions): Promise<RunResult> => {
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
      () => mockRun("No plan here"),
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
      () => mockRun("<plan>not json</plan>"),
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
      () => mockRun(`<plan>${JSON.stringify({ issues: [{ id: "only-id" }] })}</plan>`),
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
  () => mockRun(`<plan>${emptyPlan}</plan>`),
  {} as unknown as SandboxProvider,
  {} as unknown as SandboxHooks,
);

assert.deepStrictEqual(empty, [], "should return empty array for empty plan");

async function assertPlanParses(
  stdout: string,
  expectedCount: number,
  expectedFirstId?: string,
): Promise<void> {
  const result = await runPlanner(
    () => mockRun(stdout),
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
  );
  assert.strictEqual(result.length, expectedCount);
  if (expectedFirstId !== undefined) {
    assert.strictEqual(result[0]!.id, expectedFirstId);
  }
}

// ---------------------------------------------------------------------------
// Regression: nested <plan> tags (LLM parrots the prompt's literal example)
// Agent emits: <plan>` tags:\n\n<plan>{"issues":[...]}</plan>
// ---------------------------------------------------------------------------
await assertPlanParses(`<plan>\` tags:

<plan>${validPlan}</plan>`, 2, "issue-1");

// ---------------------------------------------------------------------------
// Regression: markdown code-fenced JSON inside <plan>
// Agent emits: <plan>\n```json\n{"issues":[...]}\n```\n</plan>
// ---------------------------------------------------------------------------
await assertPlanParses(`<plan>
\`\`\`json
${validPlan}
\`\`\`
</plan>`, 2, "issue-1");

// ---------------------------------------------------------------------------
// Regression: JSON with leading text preamble before the object
// Agent emits: <plan>Here is the plan:\n{"issues":[...]}</plan>
// ---------------------------------------------------------------------------
await assertPlanParses(`<plan>Here is the plan:

${validPlan}</plan>`, 2);

// ---------------------------------------------------------------------------
// Unit: extractPlanJson with combined nesting + fencing + preamble
// ---------------------------------------------------------------------------
const combined = `<plan>\` tags:

<plan>
\`\`\`json
Here is the plan:
${validPlan}
\`\`\`
</plan>`;
const combinedJson = JSON.parse(extractPlanJson(combined));
assert.strictEqual(combinedJson.issues.length, 2, "combined: should extract two issues");

console.log("All plan phase tests passed!");
