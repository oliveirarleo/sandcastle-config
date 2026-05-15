import type { RunOptions, RunResult, SandboxHooks, SandboxProvider } from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";
import { extractPlanJson, runPlanner } from "./plan.mts";

const validPlan = JSON.stringify({
	issues: [
		{
			id: "issue-1",
			title: "Fix auth bug",
			branch: "sandcastle/issue-1-fix-auth",
		},
		{
			id: "issue-2",
			title: "Add tests",
			branch: "sandcastle/issue-2-add-tests",
		},
	],
});

async function mockRun(stdout: string): Promise<RunResult> {
	return { stdout, commits: [], iterations: [], branch: "main" };
}

function captureRun(stdout: string, calls: RunOptions[]) {
	return (opts: RunOptions): Promise<RunResult> => {
		calls.push(opts);
		return mockRun(stdout);
	};
}

const NOOP_SANDBOX = {} as unknown as SandboxProvider;
const NOOP_HOOKS = {} as unknown as SandboxHooks;

describe("runPlanner", () => {
	it("returns issues from a valid <plan> tag", async () => {
		const calls: RunOptions[] = [];

		const issues = await runPlanner(
			captureRun(`<plan>${validPlan}</plan>`, calls),
			NOOP_SANDBOX,
			NOOP_HOOKS,
		);

		expect(issues).toHaveLength(2);
		expect(issues[0]?.id).toBe("issue-1");
		expect(issues[0]?.title).toBe("Fix auth bug");
		expect(issues[0]?.branch).toBe("sandcastle/issue-1-fix-auth");
		expect(issues[1]?.id).toBe("issue-2");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("planner");
		expect(calls[0]?.maxIterations).toBe(1);
		expect(calls[0]?.promptFile).toBe("./.sandcastle/prompts/plan.md");
	});

	it("throws when <plan> tag is missing", async () => {
		await expect(() =>
			runPlanner(() => mockRun("No plan here"), NOOP_SANDBOX, NOOP_HOOKS),
		).rejects.toThrow(/did not produce a <plan> tag/);
	});

	it("throws when plan contains invalid JSON", async () => {
		await expect(() =>
			runPlanner(() => mockRun("<plan>not json</plan>"), NOOP_SANDBOX, NOOP_HOOKS),
		).rejects.toThrow(/JSON/);
	});

	it("throws when plan violates schema", async () => {
		await expect(() =>
			runPlanner(
				() => mockRun(`<plan>${JSON.stringify({ issues: [{ id: "only-id" }] })}</plan>`),
				NOOP_SANDBOX,
				NOOP_HOOKS,
			),
		).rejects.toThrow(/Invalid input/);
	});

	it("returns empty array for empty plan", async () => {
		const emptyPlan = JSON.stringify({ issues: [] });
		const empty = await runPlanner(
			() => mockRun(`<plan>${emptyPlan}</plan>`),
			NOOP_SANDBOX,
			NOOP_HOOKS,
		);

		expect(empty).toEqual([]);
	});

	it("handles nested <plan> tags (LLM parrots prompt example)", async () => {
		const nestedPlan = `<plan>
\` tags:

<plan>${validPlan}</plan>`;
		const nested = await runPlanner(() => mockRun(nestedPlan), NOOP_SANDBOX, NOOP_HOOKS);
		expect(nested).toHaveLength(2);
		expect(nested[0]?.id).toBe("issue-1");
	});

	it("handles markdown code-fenced JSON inside <plan>", async () => {
		const fencedPlan = `<plan>
\`\`\`json
${validPlan}
\`\`\`
</plan>`;
		const fenced = await runPlanner(() => mockRun(fencedPlan), NOOP_SANDBOX, NOOP_HOOKS);
		expect(fenced).toHaveLength(2);
		expect(fenced[0]?.id).toBe("issue-1");
	});

	it("handles JSON with leading text preamble", async () => {
		const preamblePlan = `<plan>Here is the plan:

${validPlan}</plan>`;
		const preamble = await runPlanner(() => mockRun(preamblePlan), NOOP_SANDBOX, NOOP_HOOKS);
		expect(preamble).toHaveLength(2);
	});
});

describe("extractPlanJson", () => {
	it("handles combined nesting + fencing + preamble", () => {
		const combined = `<plan>
\` tags:

<plan>
\`\`\`json
Here is the plan:
${validPlan}
\`\`\`
</plan>`;
		const combinedJson = JSON.parse(extractPlanJson(combined));
		expect(combinedJson.issues).toHaveLength(2);
	});
});

describe("runPlanner with onPlanComplete", () => {
	it("calls onPlanComplete with planned issues", async () => {
		let captured: { id: string }[] = [];
		const onPlanComplete = async (issues: { id: string }[]) => {
			captured = issues;
		};

		const issues = await runPlanner(
			() => mockRun(`<plan>${validPlan}</plan>`),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			onPlanComplete,
		);

		expect(issues).toHaveLength(2);
		expect(captured).toHaveLength(2);
		expect(captured[0]?.id).toBe("issue-1");
	});

	it("calls onPlanComplete even for empty plan", async () => {
		let called = false;
		const onPlanComplete = async (_issues: { id: string }[]) => {
			called = true;
		};

		const emptyPlan = JSON.stringify({ issues: [] });
		await runPlanner(
			() => mockRun(`<plan>${emptyPlan}</plan>`),
			NOOP_SANDBOX,
			NOOP_HOOKS,
			undefined,
			onPlanComplete,
		);

		expect(called).toBe(true);
	});
});
