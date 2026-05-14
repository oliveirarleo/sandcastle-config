import { z } from "zod";

export const BeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});

export const PlannerOutputSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
    }),
  ),
});

export type BeadsIssue = z.infer<typeof BeadsIssueSchema>;
