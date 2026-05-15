/**
 * Sandcastle phase hooks — function-based pre/post hooks for all phases.
 *
 * Hooks are plain async functions that receive a {@link PhaseHookContext}.
 * They are externalized from the phase implementations so that side effects
 * (lint checks, dependency installation, notifications, etc.) are configured
 * in one place rather than hardcoded inline.
 *
 * Each hook runs in its own try/catch via {@link runHooks}. A single hook
 * failure never stops subsequent hooks or throws to the caller.
 */

import type { Logger } from "pino";
import type { PlannerIssue } from "../types.mts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseHookContext {
	/** The bead issue ID (set for all per-issue hooks). */
	issueId?: string;
	/** Branch name (set for merge-phase hooks). */
	branch?: string;
	/** Issue title (set for merge-phase hooks). */
	title?: string;
	/** Planned issues (set for onPostPlan). */
	issues?: PlannerIssue[];
	/** Set when the action failed (onPostReviewer, onPostMerge). */
	error?: unknown;
	logger?: Logger;
}

export type PhaseHook = (ctx: PhaseHookContext) => Promise<void>;

export interface PhaseHooks {
	onPrePlan?: PhaseHook[];
	onPostPlan?: PhaseHook[];
	onPreExecute?: PhaseHook[];
	onPostImplementer?: PhaseHook[];
	onPreReviewer?: PhaseHook[];
	onPostReviewer?: PhaseHook[];
	onPreMerge?: PhaseHook[];
	onPostMerge?: PhaseHook[];
}

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

/**
 * Run an array of hooks sequentially. Each hook is wrapped in its own
 * try/catch so a single hook failure never stops subsequent hooks or
 * throws to the caller.
 */
export async function runHooks(
	hooks: PhaseHook[] | undefined,
	ctx: PhaseHookContext,
	logger?: Logger,
): Promise<void> {
	if (!hooks) return;
	for (const hook of hooks) {
		try {
			await hook(ctx);
		} catch (err) {
			logger?.warn({ err }, "Hook failed (non-fatal)");
		}
	}
}
