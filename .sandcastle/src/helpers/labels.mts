/**
 * Sandcastle phase labels for the bead issue state machine.
 *
 * State transitions: planned → executing → reviewing → executed → merged
 *
 * Each label is stored on the bead issue via `bd update --add-label` and
 * determines where sandcastle resumes after a crash or manual stop.
 */

import { $ } from "zx";
import type { BeadsIssue } from "../types.mts";

$.verbose = false;

export const sandcastleLabelPrefix = "sandcastle:";

export const PLANNED = `${sandcastleLabelPrefix}planned`;
export const EXECUTING = `${sandcastleLabelPrefix}executing`;
export const EXECUTED = `${sandcastleLabelPrefix}executed`;
export const REVIEWING = `${sandcastleLabelPrefix}reviewing`;
export const MERGED = `${sandcastleLabelPrefix}merged`;

/**
 * Build a shell command that adds a label to a bead issue.
 *
 * The command is designed to be evaluated via `zx.$`.
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
// Executable label operations
// ---------------------------------------------------------------------------

/**
 * Add a sandcastle phase label to a bead issue.
 */
export async function addLabel(
	issueId: string,
	label: string,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<void> {
	const ex = deps?.exec ?? defaultExec;
	await ex(`bd label add "${issueId}" ${label}`);
}

/** Return the lifecycle order index for a sandcastle label. */
const LIFECYCLE_ORDER: Record<string, number> = {
	[PLANNED]: 0,
	[EXECUTING]: 1,
	[REVIEWING]: 2,
	[EXECUTED]: 3,
	[MERGED]: 4,
};

/**
 * Return the current sandcastle phase label for an issue, or null if none.
 * When multiple sandcastle labels are present, returns the one furthest
 * along in the lifecycle (planned < executing < reviewing < executed < merged).
 */
export function getResumePhase(issue: BeadsIssue): string | null {
	const sandcastleLabels = (issue.labels ?? []).filter((lbl) =>
		lbl.startsWith(sandcastleLabelPrefix),
	);
	if (sandcastleLabels.length === 0) return null;
	// Return the furthest-along label in the lifecycle
	return sandcastleLabels.reduce((best, current) => {
		return (LIFECYCLE_ORDER[current] ?? -1) > (LIFECYCLE_ORDER[best] ?? -1) ? current : best;
	});
}

// Valid transitions in the sandcastle label state machine.
const VALID_TRANSITIONS: Record<string, Set<string>> = {
	[PLANNED]: new Set([EXECUTING]),
	[EXECUTING]: new Set([REVIEWING]),
	[REVIEWING]: new Set([EXECUTED]),
	[EXECUTED]: new Set([MERGED]),
};

/**
 * Validate a state machine transition between two sandcastle labels.
 * Throws if the transition is not allowed.
 */
export function validateTransition(from: string, to: string): void {
	const allowed = VALID_TRANSITIONS[from];
	if (!allowed || !allowed.has(to)) {
		throw new Error(`Invalid transition: ${from} → ${to}`);
	}
}

/**
 * Set a metadata key-value pair on a bead issue.
 */
export async function setMetadata(
	issueId: string,
	key: string,
	value: string,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<void> {
	const ex = deps?.exec ?? defaultExec;
	await ex(`bd update "${issueId}" --set-metadata ${key}=${value}`);
}

/**
 * Get a metadata value for a key from a bead issue.
 */
export async function getMetadata(
	issueId: string,
	key: string,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<string | undefined> {
	const ex = deps?.exec ?? defaultExec;
	const stdout = await ex(`bd show "${issueId}" --json`);
	try {
		const parsed = JSON.parse(stdout);
		const metadata = parsed?.data?.[0]?.metadata;
		return metadata?.[key] ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Strip all sandcastle:* labels from every issue in the database.
 */
export async function cleanupAllSandcastleLabels(deps?: {
	exec?: (cmd: string) => Promise<string>;
}): Promise<void> {
	const ex = deps?.exec ?? defaultExec;
	const stdout = await ex("bd label list-all");
	const sandcastleLabels = stdout
		.split("\n")
		.filter((line) => line.trim().startsWith(sandcastleLabelPrefix));
	for (const label of sandcastleLabels) {
		await ex(`bd label remove ${label.trim()}`);
	}
}

/**
 * Check if a sandcastle label exists on a bead issue.
 */
export async function hasLabel(
	issueId: string,
	label: string,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<boolean> {
	const ex = deps?.exec ?? defaultExec;
	const stdout = await ex(`bd label list "${issueId}"`);
	return stdout.split("\n").some((line) => line.trim() === label);
}

/**
 * Remove a sandcastle phase label from a bead issue.
 */
export async function removeLabel(
	issueId: string,
	label: string,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<void> {
	const ex = deps?.exec ?? defaultExec;
	await ex(`bd label remove "${issueId}" ${label}`);
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

/**
 * Execute a shell command string via zx and return trimmed stdout.
 *
 * Uses `sh -c` because the input is a command string, not a template literal
 * with individual arguments that zx would otherwise escape.
 */
async function defaultExec(cmd: string): Promise<string> {
	const { stdout } = await $`sh -c ${cmd}`.quiet();
	return stdout.trim();
}

// ---------------------------------------------------------------------------
// Resume routing helpers
// ---------------------------------------------------------------------------

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
