import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlannerIssue, BeadsIssue } from './types.mts';

async function daemonLoop(deps: {
  /** Wait for open issues — returns empty to stop the daemon */
  waitForOpenIssues: () => Promise<BeadsIssue[]>;
  /** Run Phase 1: plan */
  runPlanner: () => Promise<PlannerIssue[]>;
  /** Run Phase 2: execute + review */
  runExecutionPhase: (issues: PlannerIssue[]) => Promise<PlannerIssue[]>;
  /** Run Phase 3: merge */
  runMergePhase: (completedIssues: PlannerIssue[]) => Promise<void>;
  /** Called at top of each iteration for heartbeat logging */
  heartbeat: (iteration: number) => void;
  /** Signal handler context — daemon loop reads shouldShutdown */
  signalContext: { shouldShutdown: boolean };
  /** After Phase 3, called to check if we should stop */
  onIterationComplete?: (iteration: number) => void;
}): Promise<number> {
  let iteration = 0;

  while (true) {
    iteration++;
    deps.heartbeat(iteration);

    // Poll for open issues
    const openIssues = await deps.waitForOpenIssues();
    if (openIssues.length === 0) {
      break;
    }

    // Phase 1: Plan
    let issues: PlannerIssue[];
    try {
      issues = await deps.runPlanner();
    } catch (err) {
      break;
    }

    if (issues.length === 0) {
      break;
    }

    // Phase 2: Execute + Review
    let completedIssues: PlannerIssue[];
    try {
      completedIssues = await deps.runExecutionPhase(issues);
    } catch (err) {
      continue;
    }

    const completedBranches = completedIssues.map((i) => i.branch);
    if (completedBranches.length === 0) {
      continue;
    }

    // Phase 3: Merge
    try {
      await deps.runMergePhase(completedIssues);
    } catch (err) {
      continue;
    }

    deps.onIterationComplete?.(iteration);

    // After Phase 3, check shouldShutdown — if set, break and exit
    if (deps.signalContext.shouldShutdown) {
      break;
    }
  }

  return iteration;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemonLoop', () => {
  let signalContext: { shouldShutdown: boolean };

  beforeEach(() => {
    signalContext = { shouldShutdown: false };
  });

  it('runs a single iteration when issues are available then stops on empty poll', async () => {
    const heartbeatCalls: number[] = [];
    const iterCompletes: number[] = [];

    const iterations = await daemonLoop({
      signalContext,
      heartbeat: (n) => { heartbeatCalls.push(n); },
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([]),
      runPlanner: vi.fn().mockResolvedValue([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }]),
      runExecutionPhase: vi.fn().mockResolvedValue([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }]),
      runMergePhase: vi.fn().mockResolvedValue(undefined),
      onIterationComplete: (n) => { iterCompletes.push(n); },
    });

    // Heartbeat fires at top of each loop pass (including the one that finds no issues)
    expect(iterations).toBe(2);
    expect(heartbeatCalls).toEqual([1, 2]);
    expect(iterCompletes).toEqual([1]);
  });

  it('runs multiple iterations when issues keep appearing', async () => {
    const heartbeatCalls: number[] = [];

    const iterations = await daemonLoop({
      signalContext,
      heartbeat: (n) => { heartbeatCalls.push(n); },
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', status: 'open' }])
        .mockResolvedValueOnce([]),
      runPlanner: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runExecutionPhase: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runMergePhase: vi.fn().mockResolvedValue(undefined),
    });

    // Two work iterations + final empty poll = 3 heartbeat calls
    expect(iterations).toBe(3);
    expect(heartbeatCalls).toEqual([1, 2, 3]);
  });

  it('stops after Phase 3 when shouldShutdown is set', async () => {
    const heartbeatCalls: number[] = [];
    const iterCompletes: number[] = [];

    const iterations = await daemonLoop({
      signalContext,
      heartbeat: (n) => { heartbeatCalls.push(n); },
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', status: 'open' }]),
      runPlanner: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runExecutionPhase: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runMergePhase: vi.fn().mockResolvedValue(undefined),
      onIterationComplete: (n) => {
        iterCompletes.push(n);
        if (n === 1) {
          // Simulate SIGTERM arriving during/after the first iteration
          signalContext.shouldShutdown = true;
        }
      },
    });

    expect(iterations).toBe(1);
    expect(heartbeatCalls).toEqual([1]);
    expect(iterCompletes).toEqual([1]);
  });

  it('breaks loop when planner throws in Phase 1', async () => {
    const heartbeatCalls: number[] = [];

    const iterations = await daemonLoop({
      signalContext,
      heartbeat: (n) => { heartbeatCalls.push(n); },
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }]),
      runPlanner: vi.fn()
        .mockRejectedValueOnce(new Error('planner crashed')),
      runExecutionPhase: vi.fn(),
      runMergePhase: vi.fn(),
    });

    expect(iterations).toBe(1);
    expect(heartbeatCalls).toEqual([1]);
  });

  it('continues past Phase 2 failure', async () => {
    const heartbeatCalls: number[] = [];

    const iterations = await daemonLoop({
      signalContext,
      heartbeat: (n) => { heartbeatCalls.push(n); },
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', status: 'open' }])
        .mockResolvedValueOnce([]),
      runPlanner: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runExecutionPhase: vi.fn()
        .mockRejectedValueOnce(new Error('execute failed'))  // iteration 1 fails, continue
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),  // iteration 2
      runMergePhase: vi.fn().mockResolvedValue(undefined),
    });

    // Iteration 1: Phase 2 fails → continue. Iteration 2: completes. Iteration 3: empty poll.
    expect(iterations).toBe(3);
    expect(heartbeatCalls).toEqual([1, 2, 3]);
  });

  it('continues past Phase 3 failure', async () => {
    const heartbeatCalls: number[] = [];

    const iterations = await daemonLoop({
      signalContext,
      heartbeat: (n) => { heartbeatCalls.push(n); },
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', status: 'open' }])
        .mockResolvedValueOnce([]),
      runPlanner: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runExecutionPhase: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }])
        .mockResolvedValueOnce([{ id: 'issue-2', title: 'Fix B', branch: 'branch-b' }]),
      runMergePhase: vi.fn()
        .mockRejectedValueOnce(new Error('merge failed'))  // iteration 1 fails, continue
        .mockResolvedValueOnce(undefined),  // iteration 2 succeeds
    });

    // Iteration 1: Phase 3 fails → continue. Iteration 2: completes. Iteration 3: empty poll.
    expect(iterations).toBe(3);
    expect(heartbeatCalls).toEqual([1, 2, 3]);
  });

  it('skips merge when no commits were produced in Phase 2', async () => {
    const mergeCalls: PlannerIssue[][] = [];

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([]),
      runPlanner: vi.fn()
        .mockResolvedValue([{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }]),
      runExecutionPhase: vi.fn()
        .mockResolvedValue([]),  // no commits produced
      runMergePhase: async (issues) => { mergeCalls.push(issues); },
    });

    // Merge should not be called when no commits produced
    expect(mergeCalls).toHaveLength(0);
  });
});
