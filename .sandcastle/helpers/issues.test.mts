import { describe, it, expect } from 'vitest';
import { getOpenIssues, getIssuesByLabel, waitForOpenIssues } from './issues.mts';

const validEnvelope = JSON.stringify({
  data: [
    { id: 'issue-1', title: 'First Issue', status: 'open' },
    { id: 'issue-2', title: 'Second Issue', status: 'in_progress' },
  ],
});

const labeledEnvelope = JSON.stringify({
  data: [
    { id: 'issue-3', title: 'Third Issue', status: 'open', labels: ['sandcastle:planned'] },
    { id: 'issue-4', title: 'Fourth Issue', status: 'open', labels: ['ready-for-agent', 'sandcastle:planned'] },
  ],
});

describe('getIssuesByLabel', () => {
  it('parses issues with the requested label', async () => {
    const result = await getIssuesByLabel(
      'sandcastle:planned',
      undefined,
      async () => labeledEnvelope,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('issue-3');
    expect(result[0]!.labels).toEqual(['sandcastle:planned']);
    expect(result[1]!.labels).toContain('sandcastle:planned');
  });

  it('returns empty array when query throws', async () => {
    const result = await getIssuesByLabel('any-label', undefined, async () => {
      throw new Error('command failed');
    });
    expect(result).toEqual([]);
  });

  it('returns empty array for invalid JSON', async () => {
    const result = await getIssuesByLabel(
      'any-label',
      undefined,
      async () => 'not json',
    );
    expect(result).toEqual([]);
  });
});

describe('getOpenIssues', () => {
  it('parses valid JSON envelope with two issues', async () => {
    const result = await getOpenIssues(undefined, async () => validEnvelope);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('issue-1');
    expect(result[0]!.title).toBe('First Issue');
    expect(result[1]!.status).toBe('in_progress');
  });

  it('returns empty array when JSON is invalid', async () => {
    const result = await getOpenIssues(undefined, async () => 'not json');
    expect(result).toEqual([]);
  });

  it('returns empty array when schema validation fails', async () => {
    const badSchema = JSON.stringify({
      data: [{ id: 'issue-1', title: 'Missing Status' }],
    });
    const result = await getOpenIssues(undefined, async () => badSchema);
    expect(result).toEqual([]);
  });

  it('returns empty array when query throws', async () => {
    const result = await getOpenIssues(undefined, async () => {
      throw new Error('command failed');
    });
    expect(result).toEqual([]);
  });
});

describe('waitForOpenIssues', () => {
  it('returns immediately when issues are present', async () => {
    const result = await waitForOpenIssues(1, undefined, {
      query: async () => validEnvelope,
      sleep: async () => {},
    });
    expect(result).toHaveLength(2);
  });

  it('polls until issues appear', async () => {
    let callCount = 0;
    const result = await waitForOpenIssues(1, undefined, {
      query: async () => {
        callCount++;
        if (callCount < 3) {
          return JSON.stringify({ data: [] });
        }
        return validEnvelope;
      },
      sleep: async () => {},
    });
    expect(callCount).toBe(3);
    expect(result).toHaveLength(2);
  });
});
