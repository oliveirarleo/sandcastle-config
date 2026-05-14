/**
 * Sandcastle phase labels for the bead issue state machine.
 *
 * State transitions: planned → executing → reviewing → executed → merged
 *
 * Each label is stored on the bead issue via `bd update --add-label` and
 * determines where sandcastle resumes after a crash or manual stop.
 */

export const sandcastleLabelPrefix = "sandcastle:";

export const PLANNED = `${sandcastleLabelPrefix}planned`;
export const EXECUTING = `${sandcastleLabelPrefix}executing`;
export const EXECUTED = `${sandcastleLabelPrefix}executed`;
export const REVIEWING = `${sandcastleLabelPrefix}reviewing`;
export const MERGED = `${sandcastleLabelPrefix}merged`;

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
		"bd label list-all",
		`grep '${sandcastleLabelPrefix}'`,
		"while IFS= read -r label; do",
		'  bd label remove "$label"',
		"done",
	].join(" | ");
}

// ---------------------------------------------------------------------------
// Resume routing helpers
// ---------------------------------------------------------------------------

import type { BeadsIssue } from "../types.mts";

/** Labels that indicate the planner should be skipped on startup. */
const RESUME_LABELS = new Set([EXECUTING, REVIEWING, EXECUTED, MERGED]);

/**
 * Determine if the planner phase should be skipped based on the current
 * labels of open issues.
 *
 * - If only `sandcastle:planned` (or no sandcastle labels) are present → run planner fresh.
 * - If any executing/reviewing/executed/merged labels are present → resume mode (skip planner).
 */
export function shouldSkipPlanner(openIssues: BeadsIssue[]): boolean {
	return openIssues.some((issue) => issue.labels.some((lbl) => RESUME_LABELS.has(lbl)));
}

/**
 * Classify which phase an issue should be routed to during resume.
 *
 * The label with the latest state in the lifecycle determines routing.
 */
export function classifyResumeLabel(issue: BeadsIssue): "execute" | "merge" | "skip" {
	const labels = new Set(issue.labels);

	if (labels.has(MERGED)) return "skip";
	if (labels.has(EXECUTED)) return "merge";
	if (labels.has(REVIEWING)) return "execute";
	if (labels.has(EXECUTING)) return "execute";
	if (labels.has(PLANNED)) return "execute";

	return "skip";
}
