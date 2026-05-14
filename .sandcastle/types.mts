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
export type PlannerIssue = z.infer<typeof PlannerIssueSchema>;

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;
