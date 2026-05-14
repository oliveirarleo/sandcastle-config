import { describe, expect, it } from 'vitest';
import { runWithConcurrencyLimit } from './concurrency.mts';

describe('runWithConcurrencyLimit', () => {
  it('processes all items and returns results in order', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrencyLimit(items, 2, async (item) => {
      return item * 2;
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 4 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 6 });
  });

  it('respects the concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrencyLimit(items, 2, async (item) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return item;
    });

    expect(maxRunning).toBe(2);
    expect(results).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i]).toEqual({ status: 'fulfilled', value: items[i] });
    }
  });

  it('settles all promises even when some reject', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrencyLimit(items, 2, async (item) => {
      if (item === 2) {
        throw new Error('boom');
      }
      return item * 10;
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
  });
});
