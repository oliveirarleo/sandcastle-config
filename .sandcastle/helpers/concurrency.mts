export async function runWithConcurrencyLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	const executing = new Set<Promise<void>>();

	for (let i = 0; i < items.length; i++) {
		const task = (async () => {
			try {
				const value = await fn(items[i]!, i);
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
