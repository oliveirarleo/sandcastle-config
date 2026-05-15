import { describe, expect, it } from "vitest";
import { runHooks, type PhaseHook, type PhaseHookContext, type PhaseHooks } from "./phase-hooks.mts";
import type { PlannerIssue } from "../types.mts";

// ---------------------------------------------------------------------------
// PhaseHookContext type contract
// ---------------------------------------------------------------------------

describe("PhaseHookContext type contract", () => {
	it("all fields are optional — empty context is valid", () => {
		const ctx: PhaseHookContext = {};
		expect(ctx.issueId).toBeUndefined();
		expect(ctx.branch).toBeUndefined();
		expect(ctx.title).toBeUndefined();
		expect(ctx.issues).toBeUndefined();
		expect(ctx.error).toBeUndefined();
		expect(ctx.logger).toBeUndefined();
	});

	it("can hold all fields when provided", () => {
		const issues: PlannerIssue[] = [
			{ id: "issue-1", title: "Fix A", branch: "branch-a" },
		];
		const ctx: PhaseHookContext = {
			issueId: "issue-1",
			branch: "branch-a",
			title: "Fix A",
			issues,
			error: new Error("test"),
			logger: undefined,
		};
		expect(ctx.issueId).toBe("issue-1");
		expect(ctx.branch).toBe("branch-a");
		expect(ctx.title).toBe("Fix A");
		expect(ctx.issues).toEqual(issues);
		expect(ctx.error).toBeInstanceOf(Error);
	});
});

// ---------------------------------------------------------------------------
// PhaseHooks type contract
// ---------------------------------------------------------------------------

describe("PhaseHooks type contract", () => {
	it("all hook arrays are optional", () => {
		const hooks: PhaseHooks = {};
		expect(hooks.onPrePlan).toBeUndefined();
		expect(hooks.onPostMerge).toBeUndefined();
	});

	it("can hold multiple hooks per phase", () => {
		const noop: PhaseHook = async () => {};
		const hooks: PhaseHooks = {
			onPostMerge: [noop, noop, noop],
		};
		expect(hooks.onPostMerge).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// runHooks
// ---------------------------------------------------------------------------

describe("runHooks", () => {
	it("returns immediately when hooks is undefined", async () => {
		await expect(runHooks(undefined, {})).resolves.toBeUndefined();
	});

	it("returns immediately when hooks array is empty", async () => {
		await expect(runHooks([], {})).resolves.toBeUndefined();
	});

	it("runs all hooks in order", async () => {
		const order: number[] = [];
		const hooks: PhaseHook[] = [
			async () => {
				order.push(1);
			},
			async () => {
				order.push(2);
			},
			async () => {
				order.push(3);
			},
		];

		await runHooks(hooks, {});
		expect(order).toEqual([1, 2, 3]);
	});

	it("runs remaining hooks after one throws", async () => {
		const ran: number[] = [];
		const hooks: PhaseHook[] = [
			async () => {
				ran.push(1);
				throw new Error("hook 1 failed");
			},
			async () => {
				ran.push(2);
			},
			async () => {
				ran.push(3);
			},
		];

		await runHooks(hooks, {});
		expect(ran).toEqual([1, 2, 3]);
	});

	it("does not throw even when all hooks throw", async () => {
		const hooks: PhaseHook[] = [
			async () => {
				throw new Error("fail 1");
			},
			async () => {
				throw new Error("fail 2");
			},
		];

		await expect(runHooks(hooks, {})).resolves.toBeUndefined();
	});

	it("passes context to each hook", async () => {
		const contexts: PhaseHookContext[] = [];
		const ctx: PhaseHookContext = { issueId: "issue-1", branch: "branch-a" };

		const hooks: PhaseHook[] = [
			async (c) => {
				contexts.push(c);
			},
			async (c) => {
				contexts.push(c);
			},
		];

		await runHooks(hooks, ctx);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.issueId).toBe("issue-1");
		expect(contexts[1]?.issueId).toBe("issue-1");
	});

	it("passes error context when set", async () => {
		const errors: unknown[] = [];
		const hook: PhaseHook = async ({ error }) => {
			errors.push(error);
		};

		const err = new Error("test error");
		await runHooks([hook], { error: err });
		expect(errors[0]).toBe(err);
	});
});
