import { describe, it, expect, vi } from 'vitest';
import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from '@ai-hero/sandcastle';
import { runMergePhase, type ShellExec } from './merge.mts';
import type { PlannerIssue } from '../types.mts';

const NOOP_SANDBOX = {} as unknown as SandboxProvider;
const NOOP_HOOKS = {} as unknown as SandboxHooks;

/** Shell mock that simulates a clean git working tree. */
function mockShell(stdout = ''): ShellExec {
  return vi.fn().mockResolvedValue({ stdout, stderr: '' });
}

describe('runMergePhase', () => {
  it('calls sandcastle.run once per issue with correct arguments', async () => {
    const calls: RunOptions[] = [];

    async function mockRunSandbox(options: RunOptions): Promise<RunResult> {
      calls.push(options);
      return { stdout: '', commits: [], iterations: [], branch: 'main' };
    }

    const issues: PlannerIssue[] = [
      { branch: 'branch-a', id: 'issue-1', title: 'Fix A' },
      { branch: 'branch-b', id: 'issue-2', title: 'Fix B' },
    ];

    await runMergePhase({
      runSandbox: mockRunSandbox,
      completedIssues: issues,
      sandboxProvider: NOOP_SANDBOX,
      hooks: NOOP_HOOKS,
      shell: mockShell(),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.promptArgs!.BRANCHES).toBe('- branch-a');
    expect(calls[1]!.promptArgs!.BRANCHES).toBe('- branch-b');
    expect(calls[0]!.promptArgs!.ISSUES).toBe('- issue-1: Fix A');
    expect(calls[1]!.promptArgs!.ISSUES).toBe('- issue-2: Fix B');
    expect(calls[0]!.branchStrategy).toEqual({ type: 'merge-to-head' });
    expect(calls[1]!.branchStrategy).toEqual({ type: 'merge-to-head' });
  });

  it('commits beads export when dirty before each merge', async () => {
    const shellCalls: string[] = [];
    const dirtyShell = vi.fn(async (cmd: string) => {
      shellCalls.push(cmd);
      return { stdout: cmd.startsWith('git status') ? ' M .beads/issues.jsonl' : '', stderr: '' };
    });

    await runMergePhase({
      runSandbox: async () => ({ stdout: '', commits: [], iterations: [], branch: 'main' }),
      completedIssues: [{ branch: 'branch-a', id: 'issue-1', title: 'Fix A' }],
      sandboxProvider: NOOP_SANDBOX,
      hooks: NOOP_HOOKS,
      shell: dirtyShell,
    });

    expect(shellCalls).toContain('git status --porcelain .beads/issues.jsonl');
    expect(shellCalls).toContain('git add .beads/issues.jsonl');
  });

  it('runs pnpm install after a successful merge', async () => {
    const shellCalls: string[] = [];
    const shell = vi.fn(async (cmd: string) => {
      shellCalls.push(cmd);
      return { stdout: '', stderr: '' };
    });

    await runMergePhase({
      runSandbox: async () => ({ stdout: '', commits: [], iterations: [], branch: 'main' }),
      completedIssues: [{ branch: 'branch-a', id: 'issue-1', title: 'Fix A' }],
      sandboxProvider: NOOP_SANDBOX,
      hooks: NOOP_HOOKS,
      shell,
    });

    expect(shellCalls).toContain('CI=true pnpm install --no-frozen-lockfile');
  });

  it('isolates per-branch errors: one failing merge does not block remaining branches', async () => {
    const isolatedCalls: string[] = [];

    async function mockRunWithFailure(opts: RunOptions): Promise<RunResult> {
      const branch = opts.promptArgs?.BRANCHES as string;
      isolatedCalls.push(branch);
      if (branch === '- branch-b') {
        throw new Error('merge conflict on branch-b');
      }
      return { stdout: '', commits: [], iterations: [], branch: 'main' };
    }

    const threeIssues: PlannerIssue[] = [
      { branch: 'branch-a', id: 'issue-1', title: 'Fix A' },
      { branch: 'branch-b', id: 'issue-2', title: 'Fix B' },
      { branch: 'branch-c', id: 'issue-3', title: 'Fix C' },
    ];

    await runMergePhase({
      runSandbox: mockRunWithFailure,
      completedIssues: threeIssues,
      sandboxProvider: NOOP_SANDBOX,
      hooks: NOOP_HOOKS,
      shell: mockShell(),
    });

    expect(isolatedCalls).toHaveLength(3);
    expect(isolatedCalls[0]).toBe('- branch-a');
    expect(isolatedCalls[1]).toBe('- branch-b');
    expect(isolatedCalls[2]).toBe('- branch-c');
  });

  it('does not throw when all merges fail', async () => {
    const failingCalls: string[] = [];

    async function mockAlwaysFail(opts: RunOptions): Promise<RunResult> {
      failingCalls.push(opts.promptArgs?.BRANCHES as string);
      throw new Error('merge failed');
    }

    const issues: PlannerIssue[] = [
      { branch: 'branch-a', id: 'issue-1', title: 'Fix A' },
      { branch: 'branch-b', id: 'issue-2', title: 'Fix B' },
    ];

    await expect(
      runMergePhase({
        runSandbox: mockAlwaysFail,
        completedIssues: issues,
        sandboxProvider: NOOP_SANDBOX,
        hooks: NOOP_HOOKS,
        shell: mockShell(),
      }),
    ).resolves.toBeUndefined();

    expect(failingCalls).toHaveLength(2);
  });

  it('skips merger sandbox when branch is already merged', async () => {
    // Simulate a branch that appears in git branch --merged
    const branchMergedShell = vi.fn(async (cmd: string) => {
      if (cmd === 'git branch --merged') {
        return { stdout: '  main\n  branch-a\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const sandboxCalls: string[] = [];

    await runMergePhase({
      runSandbox: async (opts) => {
        sandboxCalls.push(opts.promptArgs?.BRANCHES as string);
        return { stdout: '', commits: [], iterations: [], branch: 'main' };
      },
      completedIssues: [{ branch: 'branch-a', id: 'issue-1', title: 'Fix A' }],
      sandboxProvider: NOOP_SANDBOX,
      hooks: NOOP_HOOKS,
      shell: branchMergedShell,
    });

    // Merger sandbox is skipped because branch is already merged
    expect(sandboxCalls).toHaveLength(0);
    // pnpm install still runs
    expect(branchMergedShell).toHaveBeenCalledWith('CI=true pnpm install --no-frozen-lockfile');
  });

  it('still runs merger sandbox when branch is not merged', async () => {
    const notMergedShell = vi.fn(async (cmd: string) => {
      if (cmd === 'git branch --merged') {
        return { stdout: '  main\n  other-branch\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const sandboxCalls: string[] = [];

    await runMergePhase({
      runSandbox: async (opts) => {
        sandboxCalls.push(opts.promptArgs?.BRANCHES as string);
        return { stdout: '', commits: [], iterations: [], branch: 'main' };
      },
      completedIssues: [{ branch: 'branch-a', id: 'issue-1', title: 'Fix A' }],
      sandboxProvider: NOOP_SANDBOX,
      hooks: NOOP_HOOKS,
      shell: notMergedShell,
    });

    // Merger sandbox runs because branch is NOT in merged list
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0]).toBe('- branch-a');
  });
});
