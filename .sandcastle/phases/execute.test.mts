import assert from "assert";
import type { SandboxRunOptions, SandboxRunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { runExecutionPhase, type CreateSandboxFn } from "./execute.mts";
import type { PlannerIssue } from "../types.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRunResult(commits: { sha: string }[] = [{ sha: "abc123" }]): SandboxRunResult {
  return { stdout: "", commits, iterations: [], logFilePath: undefined };
}

function mockSandbox(runImpl: (opts: SandboxRunOptions) => Promise<SandboxRunResult> = async () => mockRunResult()) {
  let closed = false;
  return {
    run: runImpl,
    close: async () => { closed = true; },
    get closed() { return closed; },
  };
}

// ---------------------------------------------------------------------------
// Single issue: implementer produces commits → issue is completed
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
  ];

  const createSandbox: CreateSandboxFn = async () => mockSandbox();

  const result = await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    3,
  );

  assert.strictEqual(result.length, 1, "should return 1 completed issue");
  assert.strictEqual(result[0]!.id, "issue-1", "should return the correct issue");
}

// ---------------------------------------------------------------------------
// Single issue: implementer produces no commits → issue is not completed
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
  ];

  let runCount = 0;
  const createSandbox: CreateSandboxFn = async () => mockSandbox(async (opts) => {
    runCount++;
    return mockRunResult([]);
  });

  const result = await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    3,
  );

  assert.strictEqual(result.length, 0, "should return 0 completed issues when no commits");
  assert.strictEqual(runCount, 1, "implementer should run exactly once");
}

// ---------------------------------------------------------------------------
// Single issue: implementer with commits → reviewer also runs
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
  ];

  const runNames: string[] = [];
  const createSandbox: CreateSandboxFn = async () => mockSandbox(async (opts) => {
    runNames.push(opts.name ?? "unknown");
    // implementer has commits, reviewer doesn't add more
    return mockRunResult(opts.name === "implementer" ? [{ sha: "abc" }] : []);
  });

  const result = await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    3,
  );

  assert.strictEqual(result.length, 1, "should return 1 completed issue");
  assert.deepStrictEqual(runNames, ["implementer", "reviewer"], "should run implementer then reviewer");
}

// ---------------------------------------------------------------------------
// Multiple issues processed concurrently
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
    { id: "issue-2", title: "Fix B", branch: "branch-b" },
  ];

  const processed: string[] = [];
  const createSandbox: CreateSandboxFn = async (opts) => {
    return mockSandbox(async (runOpts) => {
      processed.push(runOpts.name ?? "unknown");
      return mockRunResult([{ sha: String(runOpts.promptArgs?.BRANCH ?? "unknown") }]);
    });
  };

  const result = await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    2,
  );

  assert.strictEqual(result.length, 2, "should return 2 completed issues");
  assert.strictEqual(processed.length, 4, "should run implementer+reviewer for both issues");
}

// ---------------------------------------------------------------------------
// Error in one issue does not crash other issues
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
    { id: "issue-2", title: "Fix B", branch: "branch-b" },
  ];

  const createSandbox: CreateSandboxFn = async (opts) => {
    if (opts.branch === "branch-a") {
      throw new Error("sandbox creation failed");
    }
    return mockSandbox();
  };

  const result = await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    2,
  );

  assert.strictEqual(result.length, 1, "should return 1 completed issue despite one failure");
  assert.strictEqual(result[0]!.id, "issue-2", "should complete the non-failing issue");
}

// ---------------------------------------------------------------------------
// Sandbox is closed after each issue (even on error)
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
  ];

  let sandboxClosed = false;
  const createSandbox: CreateSandboxFn = async () => {
    const sb = mockSandbox();
    const originalClose = sb.close;
    sb.close = async () => {
      sandboxClosed = true;
      await originalClose();
    };
    return sb;
  };

  await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    3,
  );

  assert.strictEqual(sandboxClosed, true, "sandbox should be closed after execution");
}

// ---------------------------------------------------------------------------
// Error during implementer run: sandbox still closed, error logged
// ---------------------------------------------------------------------------

{
  const issues: PlannerIssue[] = [
    { id: "issue-1", title: "Fix A", branch: "branch-a" },
  ];

  let sandboxClosed = false;
  const createSandbox: CreateSandboxFn = async () => {
    const sb = mockSandbox(async () => {
      throw new Error("implementer crashed");
    });
    const originalClose = sb.close;
    sb.close = async () => {
      sandboxClosed = true;
      await originalClose();
    };
    return sb;
  };

  const result = await runExecutionPhase(
    issues,
    createSandbox,
    {} as unknown as SandboxProvider,
    {} as unknown as SandboxHooks,
    [],
    3,
  );

  assert.strictEqual(result.length, 0, "should return 0 completed issues when implementer crashes");
  assert.strictEqual(sandboxClosed, true, "sandbox should be closed even after crash");
}

console.log("All execute phase tests passed!");
