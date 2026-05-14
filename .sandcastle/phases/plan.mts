import { pi, type RunOptions, type RunResult, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import { PlannerOutputSchema, type PlannerIssue } from "../types.mts";

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;

/**
 * Run the planning phase: invoke the planner agent to analyze open issues
 * and return the list of unblocked issues to work on.
 */
export async function runPlanner(
  runSandbox: RunSandbox,
  sandboxProvider: SandboxProvider,
  hooks: SandboxHooks,
  logger?: Logger,
): Promise<PlannerIssue[]> {
  logger?.debug("Running planner sandbox...");

  const plan = await runSandbox({
    name: "planner",
    maxIterations: 1,
    agent: pi("opencode-go/kimi-k2.6"),
    promptFile: "./.sandcastle/plan-prompt.md",
    sandbox: sandboxProvider,
    hooks,
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  const { issues } = PlannerOutputSchema.parse(JSON.parse(planMatch[1]));

  logger?.info({ count: issues.length }, "Planning complete");
  for (const issue of issues) {
    logger?.info(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  return issues;
}
