import { describe, expect, it } from 'vitest';
import { getIssuesByLabel, getOpenIssues, waitForOpenIssues } from './issues.mts';

const validEnvelope = JSON.stringify({
  data: [
    { id: 'issue-1', title: 'First Issue', status: 'open' },
    { id: 'issue-2', title: 'Second Issue', status: 'in_progress' },
  ],
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

describe('getIssuesByLabel', () => {
  const labeledData = JSON.stringify({
    data: [
      { id: 'issue-a', title: 'Task A', status: 'open', labels: ['sandcastle:executing'] },
      {
        id: 'issue-b',
        title: 'Task B',
        status: 'open',
        labels: ['sandcastle:executing', 'sandcastle:planned'],
      },
    ],
  });

  it('returns issues matching a label', async () => {
    const result = await getIssuesByLabel(
      'sandcastle:executing',
      undefined,
      async () => labeledData,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('issue-a');
    expect(result[1]!.id).toBe('issue-b');
  });

  it('returns empty array for label with no matches', async () => {
    const empty = JSON.stringify({ data: [] });
    const result = await getIssuesByLabel('sandcastle:merged', undefined, async () => empty);
    expect(result).toEqual([]);
  });

  it('returns empty array when query throws', async () => {
    const result = await getIssuesByLabel('sandcastle:planned', undefined, async () => {
      throw new Error('bd failed');
    });
    expect(result).toEqual([]);
  });
});
