/**
 * Sandcastle phase labels for the bead issue state machine.
 *
 * State transitions: planned → executing → reviewing → executed → merged
 *
 * Each label is stored on the bead issue via `bd update --add-label` and
 * determines where sandcastle resumes after a crash or manual stop.
 */

export const sandcastleLabelPrefix = 'sandcastle:';

export const PLANNED = `${sandcastleLabelPrefix}planned`;
export const EXECUTING = `${sandcastleLabelPrefix}executing`;
export const EXECUTED = `${sandcastleLabelPrefix}executed`;
export const REVIEWING = `${sandcastleLabelPrefix}reviewing`;
export const MERGED = `${sandcastleLabelPrefix}merged`;

/** All sandcastle:* labels, ordered by the state machine lifecycle. */
export const ALL_LABELS = [PLANNED, EXECUTING, REVIEWING, EXECUTED, MERGED] as const;

// ---------------------------------------------------------------------------
// bd command builders
// ---------------------------------------------------------------------------

/**
 * Build a shell command that adds a label to a bead issue.
 *
 * The command is designed to be evaluated via `zx.$` or `child_process.exec`.
 * Issue IDs with special characters are double-quoted to prevent injection.
 */
export function addLabelCmd(issueId: string, label: string): string {
  return `bd update "${issueId}" --add-label ${label}`;
}

/**
 * Build a shell command that removes a label from a bead issue.
 */
export function removeLabelCmd(issueId: string, label: string): string {
  return `bd update "${issueId}" --remove-label ${label}`;
}

/**
 * Build a shell pipeline that strips all sandcastle:* labels from every
 * issue in the database.
 *
 * Strategy:
 * 1. `bd label list-all` lists every unique label.
 * 2. grep filters to sandcastle:* labels.
 * 3. For each label, `bd label remove <label>` removes it from all issues.
 *
 * This is used by the `pnpm sandcastle:cleanup` script.
 */
export function stripLabelsCmd(): string {
  return [
    'bd label list-all',
    `grep '${sandcastleLabelPrefix}'`,
    'while IFS= read -r label; do',
    `  bd label remove "$label"`,
    'done',
  ].join(' | ');
}
