/**
 * Run an async function over an array of items with a bounded concurrency
 * limit. Returns a {@link PromiseSettledResult} for every item, preserving
 * input order. Rejections are captured rather than thrown, so one failure
 * never cancels the remaining work.
 */
export async function runWithConcurrencyLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	const executing = new Set<Promise<void>>();

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item === undefined) continue;
		const task = (async () => {
			try {
				const value = await fn(item, i);
				results[i] = { status: "fulfilled", value };
			} catch (reason) {
				results[i] = { status: "rejected", reason };
			}
		})();

		executing.add(task);
		task.finally(() => executing.delete(task));

		if (executing.size >= limit) {
			await Promise.race(executing);
		}
	}

	await Promise.all(executing);
	return results;
}
