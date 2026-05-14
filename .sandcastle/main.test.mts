import { describe, expect, it } from 'vitest';
import {
  classifyResumeLabel,
  EXECUTED,
  EXECUTING,
  MERGED,
  PLANNED,
  REVIEWING,
  shouldSkipPlanner,
} from './helpers/labels.mts';
import type { BeadsIssue } from './types.mts';

// ---------------------------------------------------------------------------
// shouldSkipPlanner
// ---------------------------------------------------------------------------

describe('shouldSkipPlanner', () => {
  it('returns false when no issues have sandcastle labels', () => {
    const issues: BeadsIssue[] = [
      { id: 'a', title: 'T', status: 'open', labels: [] },
      { id: 'b', title: 'T', status: 'open', labels: ['ready-for-agent'] },
    ];
    expect(shouldSkipPlanner(issues)).toBe(false);
  });

  it('returns false when all sandcastle labels are planned only', () => {
    const issues: BeadsIssue[] = [
      { id: 'a', title: 'T', status: 'open', labels: [PLANNED] },
      { id: 'b', title: 'T', status: 'open', labels: [PLANNED, 'ready-for-agent'] },
    ];
    expect(shouldSkipPlanner(issues)).toBe(false);
  });

  it('returns true when any issue has executing label', () => {
    const issues: BeadsIssue[] = [
      { id: 'a', title: 'T', status: 'open', labels: [PLANNED] },
      { id: 'b', title: 'T', status: 'open', labels: [EXECUTING] },
    ];
    expect(shouldSkipPlanner(issues)).toBe(true);
  });

  it('returns true when any issue has reviewing label', () => {
    const issues: BeadsIssue[] = [{ id: 'a', title: 'T', status: 'open', labels: [REVIEWING] }];
    expect(shouldSkipPlanner(issues)).toBe(true);
  });

  it('returns true when any issue has executed label', () => {
    const issues: BeadsIssue[] = [{ id: 'a', title: 'T', status: 'open', labels: [EXECUTED] }];
    expect(shouldSkipPlanner(issues)).toBe(true);
  });

  it('returns true when any issue has merged label (should skip entirely)', () => {
    const issues: BeadsIssue[] = [{ id: 'a', title: 'T', status: 'open', labels: [MERGED] }];
    expect(shouldSkipPlanner(issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyResumeLabel
// ---------------------------------------------------------------------------

describe('classifyResumeLabel', () => {
  function issue(labels: string[]): BeadsIssue {
    return { id: 'test', title: 'T', status: 'open', labels };
  }

  it("returns 'execute' for planned label", () => {
    expect(classifyResumeLabel(issue([PLANNED]))).toBe('execute');
  });

  it("returns 'execute' for executing label", () => {
    expect(classifyResumeLabel(issue([EXECUTING]))).toBe('execute');
  });

  it("returns 'execute' for reviewing label", () => {
    expect(classifyResumeLabel(issue([REVIEWING]))).toBe('execute');
  });

  it("returns 'merge' for executed label", () => {
    expect(classifyResumeLabel(issue([EXECUTED]))).toBe('merge');
  });

  it("returns 'skip' for merged label", () => {
    expect(classifyResumeLabel(issue([MERGED]))).toBe('skip');
  });

  it("returns 'skip' when no sandcastle labels present", () => {
    expect(classifyResumeLabel(issue(['other-label']))).toBe('skip');
  });

  it('prefers later-state labels when multiple sandcastle labels present', () => {
    // executing + executed → executed is later, so 'merge'
    expect(classifyResumeLabel(issue([EXECUTING, EXECUTED]))).toBe('merge');
  });

  it('executed takes priority over planned', () => {
    expect(classifyResumeLabel(issue([PLANNED, EXECUTED]))).toBe('merge');
  });
});
