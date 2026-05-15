/**
 * Sandcastle phase hooks — pre/post shell commands for execute and merge phases.
 *
 * Hooks are configurable shell commands that run before and after each phase
 * action. They use `zx` for execution and have their own error boundary: a
 * failed hook logs a warning but does not affect the phase result.
 *
 * Hook commands are resolved in order of priority:
 * 1. Issue metadata (sandcastle.<hook_name> key on the bead)
 * 2. Global config via environment variable
 * 3. No hook (silently skipped)
 */

import type { Logger } from "pino";
import { $ } from "zx";
import { getMetadata } from "./labels.mts";

$.verbose = false;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookType = "pre_execute" | "post_execute" | "pre_merge" | "post_merge";

// ---------------------------------------------------------------------------
// Resolution keys
// ---------------------------------------------------------------------------

/** Metadata keys stored on bead issues for per-issue hook configuration. */
const METADATA_KEYS: Record<HookType, string> = {
	pre_execute: "sandcastle.pre_execute_hook",
	post_execute: "sandcastle.post_execute_hook",
	pre_merge: "sandcastle.pre_merge_hook",
	post_merge: "sandcastle.post_merge_hook",
};

/** Environment variable keys for global hook configuration (fallback). */
const ENV_KEYS: Record<HookType, string> = {
	pre_execute: "SANDCASTLE_PRE_EXECUTE_HOOK",
	post_execute: "SANDCASTLE_POST_EXECUTE_HOOK",
	pre_merge: "SANDCASTLE_PRE_MERGE_HOOK",
	post_merge: "SANDCASTLE_POST_MERGE_HOOK",
};

// ---------------------------------------------------------------------------
// Hook resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve a hook command for a given issue.
 *
 * Priority: issue metadata > environment variable > no hook.
 */
export async function getHookCommand(
	issueId: string,
	hookType: HookType,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<string | undefined> {
	// 1. Check issue metadata
	const metadataKey = METADATA_KEYS[hookType];
	try {
		const metadataValue = await getMetadata(issueId, metadataKey, deps);
		if (metadataValue) return metadataValue;
	} catch {
		// bd unavailable or database unreachable — fall through to env var
	}

	// 2. Check environment variable
	const envKey = ENV_KEYS[hookType];
	const envValue = process.env[envKey];
	if (envValue) return envValue;

	// 3. No hook configured
	return undefined;
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

/**
 * Run a single hook command via zx.
 *
 * The command is executed through `sh -c` to support arbitrary shell syntax.
 * On failure, a warning is logged but no error is thrown.
 *
 * @returns `{ success: true }` on success, `{ success: false }` on failure.
 */
export async function runHook(
	command: string,
	hookLabel: string,
	issueId: string,
	logger?: Logger,
): Promise<{ success: boolean }> {
	logger?.info({ issueId, hook: hookLabel, command }, `Running hook: ${hookLabel}`);

	try {
		await $`sh -c ${command}`.quiet();
		logger?.info({ issueId, hook: hookLabel }, `Hook succeeded: ${hookLabel}`);
		return { success: true };
	} catch (err) {
		logger?.warn(
			{ err, issueId, hook: hookLabel, command },
			`Hook failed (non-fatal): ${hookLabel}`,
		);
		return { success: false };
	}
}

/**
 * Resolve and run a phase hook (pre or post) for a given issue.
 *
 * If no hook is configured for this issue/hook-type, returns immediately.
 * Hook failure is always non-fatal — a warning is logged but no error is thrown.
 */
export async function runPhaseHook(
	issueId: string,
	hookType: HookType,
	logger?: Logger,
	deps?: { exec?: (cmd: string) => Promise<string> },
): Promise<void> {
	try {
		const command = await getHookCommand(issueId, hookType, deps);
		if (!command) return;

		const hookLabel = `sandcastle:${hookType}`;
		await runHook(command, hookLabel, issueId, logger);
	} catch (err) {
		// Absolute safety net: hooks must never throw.
		logger?.warn(
			{ err, issueId, hookType },
			`Unexpected error in hook resolver — hook skipped: ${hookType}`,
		);
	}
}
