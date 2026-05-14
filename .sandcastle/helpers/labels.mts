/**
 * Sandcastle phase labels — persisted on bead issues as the state machine
 * for per-issue resume after crash or manual stop.
 *
 *   planned → executing → reviewing → executed → merged
 */

export const LABEL_PLANNED = "sandcastle:planned" as const;
export const LABEL_EXECUTING = "sandcastle:executing" as const;
export const LABEL_REVIEWING = "sandcastle:reviewing" as const;
export const LABEL_EXECUTED = "sandcastle:executed" as const;
export const LABEL_MERGED = "sandcastle:merged" as const;

/** All sandcastle phase labels, in transition order. */
export const ALL_SANDCASTLE_LABELS = [
  LABEL_PLANNED,
  LABEL_EXECUTING,
  LABEL_REVIEWING,
  LABEL_EXECUTED,
  LABEL_MERGED,
] as const;

export type SandcastleLabel = (typeof ALL_SANDCASTLE_LABELS)[number];

// ---------------------------------------------------------------------------
// ShellExec — injectable shell runner for test isolation
// ---------------------------------------------------------------------------

/** Shell executor for bd/git commands (injectable for testing). */
export type ShellExec = (
  command: string,
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Label management helpers
// ---------------------------------------------------------------------------

/**
 * Construct the bd update command to add one or more labels.
 * Uses --add-label (repeatable) so the caller can batch additions.
 */
export function bdAddLabelCmd(issueId: string, label: string): string {
  return `bd update ${issueId} --add-label ${label}`;
}

/**
 * Construct the bd update command to remove one or more labels.
 */
export function bdRemoveLabelCmd(issueId: string, label: string): string {
  return `bd update ${issueId} --remove-label ${label}`;
}

/**
 * Construct the bd update command to set metadata on an issue.
 */
export function bdSetMetadataCmd(
  issueId: string,
  key: string,
  value: string,
): string {
  return `bd update ${issueId} --set-metadata ${key}=${value}`;
}

/**
 * Construct the bd ready query for open issues with a specific label.
 * BD_JSON_ENVELOPE=1 returns { data: [...], schema_version: 1 }.
 */
export function bdReadyByLabelCmd(label: string): string {
  return `BD_JSON_ENVELOPE=1 bd ready --json --label '${label}'`;
}

/**
 * Construct a shell pipeline to find all bead issues that have ANY
 * sandcastle phase label (including merged on closed issues).
 *
 * Uses bd list --all (includes closed) with --label-any so we can find
 * issues in every state, not just open ones.
 */
export function bdListAllSandcastleCmd(): string {
  const labels = ALL_SANDCASTLE_LABELS.map((l) => `--label-any '${l}'`).join(
    " ",
  );
  return `BD_JSON_ENVELOPE=1 bd list --json --all ${labels}`;
}

/**
 * Construct a shell command that strips every sandcastle:* label from
 * all open issues.  Used by pnpm sandcastle:cleanup.
 */
export function bdCleanupAllCmd(): string {
  const removeFlags = ALL_SANDCASTLE_LABELS.map(
    (l) => `--remove-label '${l}'`,
  ).join(" ");
  return `bd list --json --label-any '${ALL_SANDCASTLE_LABELS.join(",")}' | \
BD_JSON_ENVELOPE=1 xargs -I{} sh -c 'id=$(echo {} | jq -r .id); bd update $id ${removeFlags}'`;
}

// ---------------------------------------------------------------------------
// Resume-query response schemas
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Shape of a single bead issue as returned by bd ready/list --json. */
export const LabeledBeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  labels: z.array(z.string()).optional().default([]),
});

export type LabeledBeadsIssue = z.infer<typeof LabeledBeadsIssueSchema>;

/** BD_JSON_ENVELOPE wrapper. */
const LabeledEnvelopeSchema = z.object({
  data: z.array(LabeledBeadsIssueSchema),
});

/**
 * Parse BD_JSON_ENVELOPE output from `bd ready` or `bd list`.
 * Returns the list of labeled issues, or [] on any parse failure.
 */
export function parseLabeledEnvelope(
  stdout: string,
): LabeledBeadsIssue[] {
  try {
    return LabeledEnvelopeSchema.parse(JSON.parse(stdout)).data;
  } catch {
    return [];
  }
}
