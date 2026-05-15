import { describe, expect, it, vi } from "vitest";
import { getHookCommand, type HookType, runHook, runPhaseHook } from "./hooks.mts";

// ---------------------------------------------------------------------------
// getHookCommand
// ---------------------------------------------------------------------------

describe("getHookCommand", () => {
	it("returns command from issue metadata when present", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(
			JSON.stringify({
				data: [{ metadata: { "sandcastle.pre_execute_hook": "echo pre" } }],
			}),
		);

		const result = await getHookCommand("issue-1", "pre_execute", { exec });

		expect(result).toBe("echo pre");
		expect(exec).toHaveBeenCalledWith('bd show "issue-1" --json');
	});

	it("returns command from environment variable when metadata is absent", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(JSON.stringify({ data: [{ metadata: {} }] }));

		// Set env var for fallback
		const prev = process.env.SANDCASTLE_PRE_EXECUTE_HOOK;
		process.env.SANDCASTLE_PRE_EXECUTE_HOOK = "echo global-pre";

		try {
			const result = await getHookCommand("issue-1", "pre_execute", { exec });
			expect(result).toBe("echo global-pre");
		} finally {
			if (prev === undefined) {
				delete process.env.SANDCASTLE_PRE_EXECUTE_HOOK;
			} else {
				process.env.SANDCASTLE_PRE_EXECUTE_HOOK = prev;
			}
		}
	});

	it("returns undefined when no hook is configured", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(JSON.stringify({ data: [{ metadata: {} }] }));

		const result = await getHookCommand("issue-1", "pre_execute", { exec });

		expect(result).toBeUndefined();
	});

	it("metadata takes priority over environment variable", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(
			JSON.stringify({
				data: [{ metadata: { "sandcastle.pre_execute_hook": "echo metadata-pre" } }],
			}),
		);

		const prev = process.env.SANDCASTLE_PRE_EXECUTE_HOOK;
		process.env.SANDCASTLE_PRE_EXECUTE_HOOK = "echo env-pre";

		try {
			const result = await getHookCommand("issue-1", "pre_execute", { exec });
			// Metadata wins
			expect(result).toBe("echo metadata-pre");
		} finally {
			if (prev === undefined) {
				delete process.env.SANDCASTLE_PRE_EXECUTE_HOOK;
			} else {
				process.env.SANDCASTLE_PRE_EXECUTE_HOOK = prev;
			}
		}
	});

	it("resolves all hook types correctly", async () => {
		const types: HookType[] = ["pre_execute", "post_execute", "pre_merge", "post_merge"];
		const expectedKeys = [
			"sandcastle.pre_execute_hook",
			"sandcastle.post_execute_hook",
			"sandcastle.pre_merge_hook",
			"sandcastle.post_merge_hook",
		];

		for (let i = 0; i < types.length; i++) {
			const exec = vi.fn<(cmd: string) => Promise<string>>();
			exec.mockResolvedValue(
				JSON.stringify({
					data: [{ metadata: { [expectedKeys[i] as string]: `echo ${types[i]}` } }],
				}),
			);

			const result = await getHookCommand("issue-1", types[i] as HookType, { exec });
			expect(result).toBe(`echo ${types[i]}`);
		}
	});
});

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

describe("runHook", () => {
	it("returns success=true when command succeeds", async () => {
		const result = await runHook("echo hello", "test:hook", "issue-1");
		expect(result).toEqual({ success: true });
	});

	it("returns success=false when command fails (non-zero exit)", async () => {
		const result = await runHook("false", "test:hook", "issue-1");
		expect(result).toEqual({ success: false });
	});

	it("never throws on failure", async () => {
		await expect(runHook("false", "test:hook", "issue-1")).resolves.toEqual({ success: false });
	});

	it("never throws on nonexistent command", async () => {
		await expect(runHook("nonexistent-command-xyz", "test:hook", "issue-1")).resolves.toEqual({
			success: false,
		});
	});
});

// ---------------------------------------------------------------------------
// runPhaseHook
// ---------------------------------------------------------------------------

describe("runPhaseHook", () => {
	it("does nothing when no hook is configured", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(JSON.stringify({ data: [{ metadata: {} }] }));

		// Should not throw
		await expect(
			runPhaseHook("issue-1", "pre_execute", undefined, { exec }),
		).resolves.toBeUndefined();
	});

	it("runs the resolved hook command", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(
			JSON.stringify({
				data: [{ metadata: { "sandcastle.pre_execute_hook": "echo hello" } }],
			}),
		);

		// Should not throw — hook runs successfully
		await expect(
			runPhaseHook("issue-1", "pre_execute", undefined, { exec }),
		).resolves.toBeUndefined();
	});

	it("does not throw when resolved hook command fails", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValue(
			JSON.stringify({
				data: [{ metadata: { "sandcastle.pre_execute_hook": "false" } }],
			}),
		);

		// Should not throw even though the command fails
		await expect(
			runPhaseHook("issue-1", "pre_execute", undefined, { exec }),
		).resolves.toBeUndefined();
	});
});
