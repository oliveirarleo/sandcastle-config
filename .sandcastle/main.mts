// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            Merge each completed branch into the current
//                               branch one at a time for isolation.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "zx";
import { setTimeout } from "timers/promises";
import { z } from "zod";
import { runMergePhase } from "./phases/merge.mts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function resolveHostPath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

const sandboxMounts =
  process.env.SANDCASTLE_NO_PI_MOUNT === "1"
    ? []
    : [{ hostPath: "~/.pi/agent" as const, sandboxPath: "~/.pi/agent" as const, readonly: false as const }];

if (
  sandboxMounts.length > 0 &&
  !fs.existsSync(resolveHostPath("~/.pi/agent"))
) {
  throw new Error(
    "The ~/.pi/agent directory is missing. Sandcastle mounts this directory into each sandbox so agents can access skills, settings, and sessions. Either create the directory or set SANDCASTLE_NO_PI_MOUNT=1 to skip the mount.",
  );
}

// In rootless Docker, the container UID 1000 maps to a different host UID,
// so bind-mounted ~/.pi/agent files are unreadable. Pass the opencode-go
// API key via env so pi can authenticate without reading auth.json.
function readOpencodeApiKey(): string | undefined {
  try {
    const authPath = resolveHostPath("~/.pi/agent/auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    return auth["opencode-go"]?.key;
  } catch {
    return undefined;
  }
}

const opencodeApiKey = readOpencodeApiKey();
const sandboxProvider = docker({
  mounts: sandboxMounts,
  env: opencodeApiKey
    ? { OPENCODE_API_KEY: opencodeApiKey }
    : undefined,
});

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Maximum number of bead tasks to run in parallel during Phase 2.
// Default: 3. Override with SANDCASTLE_MAX_PARALLEL env var.
const MAX_PARALLEL_TASKS = Number(process.env.SANDCASTLE_MAX_PARALLEL ?? "3");

// How long to sleep between polls for new open issues (milliseconds).
// Default: 5 minutes. Override with SANDCASTLE_POLL_MS env var.
const POLL_INTERVAL_MS = Number(process.env.SANDCASTLE_POLL_MS ?? "300000");

// ---------------------------------------------------------------------------
// Helper: run tasks with a concurrency limit
// ---------------------------------------------------------------------------

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const iterator = items.entries();

  async function worker(): Promise<void> {
    for (const [i, item] of iterator) {
      try {
        results[i] = { status: "fulfilled", value: await fn(item, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Helper: check for open issues via beads (bd)
// ---------------------------------------------------------------------------

const BeadsIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});

const PlannerOutputSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
    }),
  ),
});

type BeadsIssue = z.infer<typeof BeadsIssueSchema>;

async function getOpenIssues(): Promise<BeadsIssue[]> {
  try {
    const stdout = await $`BD_JSON_ENVELOPE=1 bd ready --json --label ready-for-agent`.text();
    const parsed = JSON.parse(stdout);
    return z.object({ data: z.array(BeadsIssueSchema) }).parse(parsed).data;
  } catch (err) {
    console.error("Failed to query open issues:", err);
    return [];
  }
}

async function waitUntilThereAreOpenIssues(): Promise<BeadsIssue[]> {
  while (true) {
    const openIssues = await getOpenIssues();
    if (openIssues.length > 0) {
      return openIssues;
    }
    await setTimeout(POLL_INTERVAL_MS);
  }
}

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "CI=true pnpm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
// .beads is included so the planner can query issues via `bd` inside the sandbox.
const copyToWorktree = ["node_modules", ".pnpm-store", ".beads"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  // -----------------------------------------------------------------------
  // Poll for open issues
  // -----------------------------------------------------------------------
  const openIssues = await waitUntilThereAreOpenIssues();
  console.log(`Found ${openIssues.length} open issue(s). Starting planner...`);
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: sandboxProvider,
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code.
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.pi("opencode-go/kimi-k2.6"),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  // Extract the <plan>…</plan> block from the agent's stdout.
  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  // The plan JSON contains an array of issues, each with id, title, branch.
  const { issues } = PlannerOutputSchema.parse(JSON.parse(planMatch[1]!));

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await runWithConcurrencyLimit(
    issues,
    MAX_PARALLEL_TASKS,
    async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: sandboxProvider,
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.pi("opencode-go/kimi-k2.6"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        // Only review if the implementer produced commits
        if (implement.commits.length > 0) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: sandcastle.pi("opencode-go/kimi-k2.6"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
            },
          });

          // Merge commits from both runs so the merge phase sees all of them.
          // Each sandbox.run() only returns commits from its own run.
          return {
            ...review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        return implement;
      } finally {
        await sandbox.close();
      }
    },
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // ---------------------------------------------------------------------
  // Phase 3: Merge
  //
  // Merge each completed branch into the current branch one at a time.
  // This isolates failures: if one merge conflicts or fails tests, the
  // process stops there instead of leaving the repo in an ambiguous
  // partially-merged state.
  // ---------------------------------------------------------------------
  await runMergePhase(
    sandcastle.run,
    completedIssues,
    sandboxProvider,
    hooks,
  );

  console.log("\nBranches merged.");
}
