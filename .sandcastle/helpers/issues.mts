import { $ } from "zx";
import { z } from "zod";
import { setTimeout as delay } from "timers/promises";
import type { Logger } from "pino";
import { BeadsIssueSchema, type BeadsIssue } from "../types.mts";

const BeadsEnvelopeSchema = z.object({ data: z.array(BeadsIssueSchema) });

export async function getOpenIssues(
  logger?: Logger,
  query: () => Promise<string> = async () =>
    $`BD_JSON_ENVELOPE=1 bd ready --json --label ready-for-agent`.text(),
): Promise<BeadsIssue[]> {
  try {
    const stdout = await query();
    return BeadsEnvelopeSchema.parse(JSON.parse(stdout)).data;
  } catch (err) {
    logger?.error({ err }, "Failed to query open issues");
    return [];
  }
}

/**
 * Query open issues that have a specific label.
 * Uses `bd ready --json --label <label>` to find ready (open, unblocked)
 * issues with the given label.
 */
export async function getIssuesByLabel(
  label: string,
  logger?: Logger,
  query: () => Promise<string> = async () =>
    $`BD_JSON_ENVELOPE=1 bd ready --json --label '${label}'`.text(),
): Promise<BeadsIssue[]> {
  try {
    const stdout = await query();
    return BeadsEnvelopeSchema.parse(JSON.parse(stdout)).data;
  } catch (err) {
    logger?.error({ err, label }, "Failed to query issues by label");
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
