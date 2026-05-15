import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import { z } from "zod";

export const BeadsIssueSchema = z.object({
	id: z.string(),
	title: z.string(),
	status: z.string(),
	labels: z.array(z.string()).optional().default([]),
});

export const PlannerIssueSchema = z.object({
	id: z.string(),
	title: z.string(),
	branch: z.string(),
});

export const PlannerOutputSchema = z.object({
	issues: z.array(PlannerIssueSchema),
});

export type BeadsIssue = z.infer<typeof BeadsIssueSchema>;

/** A planned issue extended with optional resume session data.
 *
 * The ZodSchema only covers fields from the planner output. Resume fields
 * are populated internally by the execute phase based on issue metadata. */
export interface PlannerIssue extends z.infer<typeof PlannerIssueSchema> {
	/** Resume session ID for the implementer agent, or undefined for fresh start. */
	implementSession?: string;
	/** Resume session ID for the reviewer agent, or undefined for fresh start. */
	reviewSession?: string;
	/** When true, skip the implementer and go straight to the reviewer. */
	skipImplementer?: boolean;
}

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;
