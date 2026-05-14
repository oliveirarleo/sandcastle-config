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
  /** Resume check: returns issues grouped by label, or null for normal flow */
  checkResume?: () => Promise<{
    executing: PlannerIssue[];
    reviewing: PlannerIssue[];
    executed: PlannerIssue[];
  } | null>;
  /** Called after planning to label each issue */
  onPlanned?: (issues: PlannerIssue[]) => Promise<void>;
  /** Called after successful merge to label each issue */
  onMerged?: (issues: PlannerIssue[]) => Promise<void>;
}): Promise<number> {
  let iteration = 0;

  // Resume: if issues exist in executing/reviewing/executed state, route them
  // before entering the normal poll loop.
  if (deps.checkResume) {
    try {
      const resume = await deps.checkResume();
      if (resume) {
        const { executing, reviewing, executed } = resume;
        const executeIssues = [...executing, ...reviewing];

        // Route executing + reviewing through execute phase
        let completed: PlannerIssue[] = [];
        if (executeIssues.length > 0) {
          try {
            completed = await deps.runExecutionPhase(executeIssues);
          } catch {
            // execute failed — still try to merge already-executed issues
          }
        }

        // Route executed + newly-completed through merge phase
        const mergeIssues = [...executed, ...completed];
        if (mergeIssues.length > 0) {
          try {
            await deps.runMergePhase(mergeIssues);
          } catch {
            // merge failed — continue to normal loop
          }

          if (deps.onMerged) {
            await deps.onMerged(mergeIssues);
          }
        }
      }
    } catch {
      // Resume check failed — fall through to normal flow
    }
  }

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

    // Label planned issues
    if (deps.onPlanned) {
      await deps.onPlanned(issues);
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

    // Label merged issues
    if (deps.onMerged) {
      await deps.onMerged(completedIssues);
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

// ---------------------------------------------------------------------------
// Resume-aware routing tests
// ---------------------------------------------------------------------------

describe('resume routing', () => {
  let signalContext: { shouldShutdown: boolean };

  beforeEach(() => {
    signalContext = { shouldShutdown: false };
  });

  it('resumes executing issues: routes to execute then merge', async () => {
    const plannedCalls: PlannerIssue[][] = [];
    const mergedCalls: PlannerIssue[][] = [];
    const executeCalls: PlannerIssue[][] = [];

    const resumeIssue: PlannerIssue = { id: 'issue-1', title: 'Fix A', branch: 'branch-a' };

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn().mockResolvedValue([]),
      runPlanner: vi.fn(),
      runExecutionPhase: async (issues) => {
        executeCalls.push(issues);
        return issues;
      },
      runMergePhase: async (issues) => { mergedCalls.push(issues); },
      checkResume: async () => ({
        executing: [resumeIssue],
        reviewing: [],
        executed: [],
      }),
      onPlanned: async (issues) => { plannedCalls.push(issues); },
      onMerged: async (issues) => {},
    });

    // Executing issue was routed to execute, then merge, planner NOT called
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toEqual([resumeIssue]);
    expect(mergedCalls).toHaveLength(1);
    expect(plannedCalls).toHaveLength(0); // planner was skipped
  });

  it('resumes reviewing issues: routes to execute (reviewer resumes, no implementer)', async () => {
    const executeCalls: PlannerIssue[][] = [];

    const resumeIssue: PlannerIssue = { id: 'issue-1', title: 'Fix A', branch: 'branch-a' };

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn().mockResolvedValue([]),
      runPlanner: vi.fn(),
      runExecutionPhase: async (issues) => {
        executeCalls.push(issues);
        return issues;
      },
      runMergePhase: async () => {},
      checkResume: async () => ({
        executing: [],
        reviewing: [resumeIssue],
        executed: [],
      }),
    });

    // Reviewing issues go through execute phase (reviewer resumes)
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toEqual([resumeIssue]);
  });

  it('resumes executed issues: routes directly to merge, skips execute', async () => {
    const executeCalls: PlannerIssue[][] = [];
    const mergeCalls: PlannerIssue[][] = [];

    const resumeIssue: PlannerIssue = { id: 'issue-1', title: 'Fix A', branch: 'branch-a' };

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn().mockResolvedValue([]),
      runPlanner: vi.fn(),
      runExecutionPhase: async (issues) => { executeCalls.push(issues); return []; },
      runMergePhase: async (issues) => { mergeCalls.push(issues); },
      checkResume: async () => ({
        executing: [],
        reviewing: [],
        executed: [resumeIssue],
      }),
      onMerged: async () => {},
    });

    // Executed issues skip execute, go directly to merge
    expect(executeCalls).toHaveLength(0);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toEqual([resumeIssue]);
  });

  it('cold start (no resume): planner, execute, merge run normally', async () => {
    const planCalls: number[] = [];
    const plannedLabels: PlannerIssue[][] = [];
    const mergedLabels: PlannerIssue[][] = [];

    const issue: PlannerIssue = { id: 'issue-1', title: 'Fix A', branch: 'branch-a' };

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open' }])
        .mockResolvedValueOnce([]),
      runPlanner: async () => {
        planCalls.push(1);
        return [issue];
      },
      runExecutionPhase: async () => [issue],
      runMergePhase: async () => {},
      checkResume: async () => null, // no resume
      onPlanned: async (issues) => { plannedLabels.push(issues); },
      onMerged: async (issues) => { mergedLabels.push(issues); },
    });

    expect(planCalls).toHaveLength(1);
    expect(plannedLabels).toHaveLength(1);
    expect(plannedLabels[0]).toEqual([issue]);
    expect(mergedLabels).toHaveLength(1);
    expect(mergedLabels[0]).toEqual([issue]);
  });

  it('resume with only planned labels: planner runs fresh (normal flow)', async () => {
    // When checkResume returns null (only planned/no resume-needed labels),
    // the normal flow runs — planner is called
    const plannerCalled: boolean[] = [];

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn()
        .mockResolvedValueOnce([{ id: 'issue-1', title: 'Fix A', status: 'open', labels: ['sandcastle:planned'] }])
        .mockResolvedValueOnce([]),
      runPlanner: async () => {
        plannerCalled.push(true);
        return [{ id: 'issue-1', title: 'Fix A', branch: 'branch-a' }];
      },
      runExecutionPhase: async () => [],
      runMergePhase: async () => {},
      checkResume: async () => null, // only planned → no resume → normal flow
    });

    expect(plannerCalled).toHaveLength(1);
  });

  it('resume with mixed states: executing + executed issues routed correctly', async () => {
    const executeCalls: PlannerIssue[][] = [];
    const mergeCalls: PlannerIssue[][] = [];

    const execIssue: PlannerIssue = { id: 'issue-1', title: 'Fix A', branch: 'branch-a' };
    const doneIssue: PlannerIssue = { id: 'issue-2', title: 'Fix B', branch: 'branch-b' };

    await daemonLoop({
      signalContext,
      heartbeat: vi.fn(),
      waitForOpenIssues: vi.fn().mockResolvedValue([]),
      runPlanner: vi.fn(),
      runExecutionPhase: async (issues) => {
        executeCalls.push(issues);
        return [execIssue]; // executing issue completed
      },
      runMergePhase: async (issues) => { mergeCalls.push(issues); },
      checkResume: async () => ({
        executing: [execIssue],
        reviewing: [],
        executed: [doneIssue],
      }),
      onMerged: async () => {},
    });

    // executing routed to execute
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toEqual([execIssue]);
    // merge gets: executed + newly-completed = [doneIssue, execIssue]
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toHaveLength(2);
    expect(mergeCalls[0]![0]).toEqual(doneIssue);
    expect(mergeCalls[0]![1]).toEqual(execIssue);
  });
});
