import { describe, expect, it } from 'vitest';
import {
  addLabelCmd,
  EXECUTED,
  EXECUTING,
  MERGED,
  PLANNED,
  REVIEWING,
  sandcastleLabelPrefix,
  stripLabelsCmd,
} from './labels.mts';

describe('label constants', () => {
  it('all labels start with sandcastle: prefix', () => {
    for (const label of [PLANNED, EXECUTING, REVIEWING, EXECUTED, MERGED]) {
      expect(label.startsWith(sandcastleLabelPrefix)).toBe(true);
    }
  });

  it('labels follow the expected state machine order', () => {
    expect(PLANNED).toBe('sandcastle:planned');
    expect(EXECUTING).toBe('sandcastle:executing');
    expect(REVIEWING).toBe('sandcastle:reviewing');
    expect(EXECUTED).toBe('sandcastle:executed');
    expect(MERGED).toBe('sandcastle:merged');
  });
});

describe('addLabelCmd', () => {
  it('builds a bd update command with --add-label', () => {
    const cmd = addLabelCmd('issue-1', PLANNED);
    expect(cmd).toContain('bd update');
    expect(cmd).toContain('issue-1');
    expect(cmd).toContain('--add-label sandcastle:planned');
  });

  it('escapes issue IDs with special characters', () => {
    const cmd = addLabelCmd('issue/with-slashes', EXECUTING);
    expect(cmd).toContain('issue/with-slashes');
    expect(cmd).toContain('--add-label sandcastle:executing');
  });
});

describe('stripLabelsCmd', () => {
  it('builds a shell pipeline to remove all sandcastle:* labels', () => {
    const cmd = stripLabelsCmd();
    expect(cmd).toContain('bd label list-all');
    expect(cmd).toContain('sandcastle:');
    expect(cmd).toContain('while IFS=');
  });

  it('produces a command that is safe to execute in a shell context', () => {
    const cmd = stripLabelsCmd();
    // Should not throw when executed in $({...}) via zx
    expect(cmd).not.toContain(';rm');
    expect(cmd).not.toContain('&& rm');
  });
});
