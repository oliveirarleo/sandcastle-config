import type {
  SandboxHooks,
  SandboxProvider,
  SandboxRunOptions,
  SandboxRunResult,
} from '@ai-hero/sandcastle';
import { describe, expect, it } from 'vitest';
import type { PlannerIssue } from '../types.mts';
import { type CreateSandboxFn, runExecutionPhase } from './execute.mts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_SANDBOX = {} as unknown as SandboxProvider;
const NOOP_HOOKS = {} as unknown as SandboxHooks;

function mockRunResult(commits: { sha: string }[] = [{ sha: 'abc123' }]): SandboxRunResult {
  return { stdout: '', commits, iterations: [], logFilePath: undefined };
}

function mockSandbox(
  runImpl: (opts: SandboxRunOptions) => Promise<SandboxRunResult> = async () => mockRunResult(),
) {
  let closed = false;
  return {
    run: runImpl,
    close: async () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

function sandboxWithCloseTracker(
  runImpl?: (opts: SandboxRunOptions) => Promise<SandboxRunResult>,
): { createSandbox: CreateSandboxFn; wasClosed: () => boolean } {
  let closed = false;
  const createSandbox: CreateSandboxFn = async () => {
    const sb = mockSandbox(runImpl);
    const originalClose = sb.close;
    sb.close = async () => {
      closed = true;
      await originalClose();
    };
    return sb;
  };
  return { createSandbox, wasClosed: () => closed };
}

describe('runExecutionPhase', () => {
  it('completes a single issue when implementer produces commits', async () => {
    const issues: PlannerIssue[] = [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }];

    const createSandbox: CreateSandboxFn = async () => mockSandbox();

    const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 3);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('issue-1');
  });

  it('does not complete issue when implementer produces no commits', async () => {
    const issues: PlannerIssue[] = [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }];

    let runCount = 0;
    const createSandbox: CreateSandboxFn = async () =>
      mockSandbox(async () => {
        runCount++;
        return mockRunResult([]);
      });

    const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 3);

    expect(result).toHaveLength(0);
    expect(runCount).toBe(1);
  });

  it('runs reviewer after implementer with commits', async () => {
    const issues: PlannerIssue[] = [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }];

    const runNames: string[] = [];
    const createSandbox: CreateSandboxFn = async () =>
      mockSandbox(async (opts) => {
        runNames.push(opts.name ?? 'unknown');
        return mockRunResult(opts.name === 'implementer' ? [{ sha: 'abc' }] : []);
      });

    const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 3);

    expect(result).toHaveLength(1);
    expect(runNames).toEqual(['implementer', 'reviewer']);
  });

  it('processes multiple issues concurrently', async () => {
    const issues: PlannerIssue[] = [
      { id: 'issue-1', title: 'Fix A', branch: 'branch-a' },
      { id: 'issue-2', title: 'Fix B', branch: 'branch-b' },
    ];

    const processed: string[] = [];
    const createSandbox: CreateSandboxFn = async (_opts) => {
      return mockSandbox(async (runOpts) => {
        processed.push(runOpts.name ?? 'unknown');
        return mockRunResult([{ sha: String(runOpts.promptArgs?.BRANCH ?? 'unknown') }]);
      });
    };

    const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 2);

    expect(result).toHaveLength(2);
    expect(processed).toHaveLength(4);
  });

  it('does not crash other issues when one fails', async () => {
    const issues: PlannerIssue[] = [
      { id: 'issue-1', title: 'Fix A', branch: 'branch-a' },
      { id: 'issue-2', title: 'Fix B', branch: 'branch-b' },
    ];

    const createSandbox: CreateSandboxFn = async (opts) => {
      if (opts.branch === 'branch-a') {
        throw new Error('sandbox creation failed');
      }
      return mockSandbox();
    };

    const result = await runExecutionPhase(issues, createSandbox, NOOP_SANDBOX, NOOP_HOOKS, [], 2);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('issue-2');
  });

  it('closes sandbox after each issue', async () => {
    const { createSandbox, wasClosed } = sandboxWithCloseTracker();

    await runExecutionPhase(
      [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }],
      createSandbox,
      NOOP_SANDBOX,
      NOOP_HOOKS,
      [],
      3,
    );

    expect(wasClosed()).toBe(true);
  });

  it('closes sandbox even after implementer crash', async () => {
    const { createSandbox, wasClosed } = sandboxWithCloseTracker(async () => {
      throw new Error('implementer crashed');
    });

    const result = await runExecutionPhase(
      [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }],
      createSandbox,
      NOOP_SANDBOX,
      NOOP_HOOKS,
      [],
      3,
    );

    expect(result).toHaveLength(0);
    expect(wasClosed()).toBe(true);
  });

  it('calls onImplementStart when implementer begins', async () => {
    const calls: string[] = [];
    const callbacks = {
      onImplementStart: (issueId: string) => {
        calls.push(`implement:${issueId}`);
        return Promise.resolve();
      },
    };

    await runExecutionPhase(
      [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }],
      async () => mockSandbox(),
      NOOP_SANDBOX,
      NOOP_HOOKS,
      [],
      3,
      undefined,
      callbacks,
    );

    expect(calls).toEqual(['implement:issue-1']);
  });

  it('calls onReviewStart when reviewer begins', async () => {
    const calls: string[] = [];
    const callbacks = {
      onReviewStart: (issueId: string) => {
        calls.push(`review:${issueId}`);
        return Promise.resolve();
      },
    };

    await runExecutionPhase(
      [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }],
      async () => mockSandbox(),
      NOOP_SANDBOX,
      NOOP_HOOKS,
      [],
      3,
      undefined,
      callbacks,
    );

    expect(calls).toEqual(['review:issue-1']);
  });

  it('calls onExecuteComplete after implement + review complete', async () => {
    const calls: string[] = [];
    const callbacks = {
      onExecuteComplete: (issueId: string) => {
        calls.push(`complete:${issueId}`);
        return Promise.resolve();
      },
    };

    const result = await runExecutionPhase(
      [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }],
      async () => mockSandbox(),
      NOOP_SANDBOX,
      NOOP_HOOKS,
      [],
      3,
      undefined,
      callbacks,
    );

    expect(result).toHaveLength(1);
    expect(calls).toEqual(['complete:issue-1']);
  });

  it('does not call onExecuteComplete when implementer produces no commits', async () => {
    const calls: string[] = [];
    const callbacks = {
      onExecuteComplete: (issueId: string) => {
        calls.push(`complete:${issueId}`);
        return Promise.resolve();
      },
    };

    const result = await runExecutionPhase(
      [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }],
      async () => mockSandbox(async () => mockRunResult([])),
      NOOP_SANDBOX,
      NOOP_HOOKS,
      [],
      3,
      undefined,
      callbacks,
    );

    expect(result).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});
