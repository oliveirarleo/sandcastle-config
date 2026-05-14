import { pi, type RunOptions, type RunResult, type SandboxHooks, type SandboxProvider } from "@ai-hero/sandcastle";
import type { Logger } from "pino";
import { PlannerOutputSchema, type PlannerIssue } from "../types.mts";

export type RunSandbox = (options: RunOptions) => Promise<RunResult>;

/**
 * Robustly extract a JSON object from LLM agent output that may contain
 * nested <plan> tags, markdown code fences, or preamble text.
 */
export function extractPlanJson(stdout: string): string {
  const planMatch = stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + stdout,
    );
  }

  let content = planMatch[1]!.trim();

  // Handle nested <plan> tags (LLM may emit the prompt's example literally).
  // Extract the innermost <plan> content.
  const inner = content.match(/<plan>([\s\S]*?)<\/plan>/);
  if (inner) {
    content = inner[1]!.trim();
  }

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    content = fenceMatch[1]!.trim();
  }

  // Find the outermost JSON object in whatever text remains.
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      "Planning agent's <plan> content does not contain a JSON object.\n\n" + stdout,
    );
  }

  return jsonMatch[0];
}

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
    agent: pi("opencode-go/deepseek-v4-pro"),
    promptFile: "./.sandcastle/plan-prompt.md",
    sandbox: sandboxProvider,
    hooks,
  });

  const json = extractPlanJson(plan.stdout);
  const { issues } = PlannerOutputSchema.parse(JSON.parse(json));

  logger?.info({ count: issues.length }, "Planning complete");
  for (const issue of issues) {
    logger?.info(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  return issues;
}
