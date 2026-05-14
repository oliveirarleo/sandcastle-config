import { $ } from "zx";
import { z } from "zod";
import { setTimeout as sleep } from "timers/promises";
import type { Logger } from "pino";
import { BeadsIssueSchema, type BeadsIssue } from "../types.mts";

/**
 * Query beads for issues labelled ready-for-agent.
 *
 * @param logger      Optional pino logger for error reporting.
 * @param query       Optional override for the shell command that fetches
 *                    issue JSON. Defaults to `bd ready --json`.
 */
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

/**
 * Poll until at least one open issue is found.
 *
 * @param pollIntervalMs  Milliseconds to sleep between polls.
 * @param logger          Optional pino logger for debug / info output.
 * @param deps            Optional overrides for testability.
 */
export async function waitForOpenIssues(
  pollIntervalMs: number,
  logger?: Logger,
  deps: {
    query?: () => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<BeadsIssue[]> {
  const { query, sleep: doSleep = sleep } = deps;
  while (true) {
    const openIssues = await getOpenIssues(logger, query);
    logger?.debug({ openIssues }, "Polled for open issues");
    if (openIssues.length > 0) {
      logger?.info({ count: openIssues.length }, "Found open issues");
      return openIssues;
    }
    await doSleep(pollIntervalMs);
  }
}
