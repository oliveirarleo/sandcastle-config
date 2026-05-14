import type { Logger } from "pino";
import { setTimeout as delay } from "timers/promises";
import { z } from "zod";
import { $ } from "zx";
import { type BeadsIssue, BeadsIssueSchema } from "../types.mts";

export async function getOpenIssues(
	logger?: Logger,
	query: () => Promise<string> = async () =>
		$`BD_JSON_ENVELOPE=1 bd ready --json --label ready-for-agent`.text(),
): Promise<BeadsIssue[]> {
	try {
		const stdout = await query();
		const parsed = JSON.parse(stdout);
		return z.object({ data: z.array(BeadsIssueSchema) }).parse(parsed).data;
	} catch (err) {
		logger?.error({ err }, "Failed to query open issues");
		return [];
	}
}

export async function waitForOpenIssues(
	pollIntervalMs: number,
	logger?: Logger,
	deps: {
		query?: () => Promise<string>;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<BeadsIssue[]> {
	const { query, sleep = delay } = deps;
	while (true) {
		const openIssues = await getOpenIssues(logger, query);
		logger?.debug({ openIssues }, "Polled for open issues");
		if (openIssues.length > 0) {
			logger?.info({ count: openIssues.length }, "Found open issues");
			return openIssues;
		}
		await sleep(pollIntervalMs);
	}
}
