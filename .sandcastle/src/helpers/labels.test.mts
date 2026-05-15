import { describe, expect, it, vi } from "vitest";
import {
	addLabel,
	addLabelCmd,
	cleanupAllSandcastleLabels,
	EXECUTED,
	EXECUTING,
	getMetadata,
	getResumePhase,
	hasLabel,
	MERGED,
	PLANNED,
	REVIEWING,
	removeLabel,
	revertPhaseLabel,
	sandcastleLabelPrefix,
	setMetadata,
	stripLabelsCmd,
	validateTransition,
} from "./labels.mts";

describe("label constants", () => {
	it("all labels start with sandcastle: prefix", () => {
		for (const label of [PLANNED, EXECUTING, REVIEWING, EXECUTED, MERGED]) {
			expect(label.startsWith(sandcastleLabelPrefix)).toBe(true);
		}
	});

	it("labels follow the expected state machine order", () => {
		expect(PLANNED).toBe("sandcastle:planned");
		expect(EXECUTING).toBe("sandcastle:executing");
		expect(REVIEWING).toBe("sandcastle:reviewing");
		expect(EXECUTED).toBe("sandcastle:executed");
		expect(MERGED).toBe("sandcastle:merged");
	});
});

describe("addLabelCmd", () => {
	it("builds a bd update command with --add-label", () => {
		const cmd = addLabelCmd("issue-1", PLANNED);
		expect(cmd).toContain("bd update");
		expect(cmd).toContain("issue-1");
		expect(cmd).toContain("--add-label sandcastle:planned");
	});

	it("escapes issue IDs with special characters", () => {
		const cmd = addLabelCmd("issue/with-slashes", EXECUTING);
		expect(cmd).toContain("issue/with-slashes");
		expect(cmd).toContain("--add-label sandcastle:executing");
	});
});

describe("stripLabelsCmd", () => {
	it("builds a shell pipeline to remove all sandcastle:* labels", () => {
		const cmd = stripLabelsCmd();
		expect(cmd).toContain("bd label list-all");
		expect(cmd).toContain("sandcastle:");
		expect(cmd).toContain("while IFS=");
	});

	it("produces a command that is safe to execute in a shell context", () => {
		const cmd = stripLabelsCmd();
		// Should not throw when executed in $({...}) via zx
		expect(cmd).not.toContain(";rm");
		expect(cmd).not.toContain("&& rm");
	});
});

describe("addLabel", () => {
	it("executes bd label add with correct issue and label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await addLabel("issue-1", PLANNED, { exec });
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${PLANNED}`);
	});
});

describe("hasLabel", () => {
	it("returns true when label is present", async () => {
		const exec = vi
			.fn<(cmd: string) => Promise<string>>()
			.mockResolvedValue("sandcastle:planned\nsandcastle:executing\n");
		const result = await hasLabel("issue-1", "sandcastle:executing", { exec });
		expect(result).toBe(true);
	});

	it("returns false when label is absent", async () => {
		const exec = vi
			.fn<(cmd: string) => Promise<string>>()
			.mockResolvedValue("sandcastle:planned\n");
		const result = await hasLabel("issue-1", "sandcastle:executing", { exec });
		expect(result).toBe(false);
	});

	it("returns false on empty output", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const result = await hasLabel("issue-1", "sandcastle:planned", { exec });
		expect(result).toBe(false);
	});

	it("executes bd label list with correct issue", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await hasLabel("issue-1", "sandcastle:planned", { exec });
		expect(exec).toHaveBeenCalledWith(`bd label list "issue-1"`);
	});
});

describe("getResumePhase", () => {
	it("returns the sandcastle label when present", () => {
		const result = getResumePhase({
			id: "i1",
			title: "T",
			status: "open",
			labels: ["sandcastle:executing"],
		});
		expect(result).toBe("sandcastle:executing");
	});

	it("returns null when no sandcastle labels present", () => {
		const result = getResumePhase({
			id: "i1",
			title: "T",
			status: "open",
			labels: ["other:label"],
		});
		expect(result).toBeNull();
	});

	it("returns null when labels array is empty", () => {
		const result = getResumePhase({ id: "i1", title: "T", status: "open", labels: [] });
		expect(result).toBeNull();
	});

	it("returns null when labels field is missing", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing missing labels field at runtime
		const result = getResumePhase({ id: "i1", title: "T", status: "open" } as any);
		expect(result).toBeNull();
	});

	it("returns the latest sandcastle label when multiple are present", () => {
		const result = getResumePhase({
			id: "i1",
			title: "T",
			status: "open",
			labels: ["sandcastle:planned", "sandcastle:executing"],
		});
		expect(result).toBe("sandcastle:executing");
	});
});

describe("validateTransition", () => {
	it("allows planned → executing", () => {
		expect(() => validateTransition(PLANNED, EXECUTING)).not.toThrow();
	});

	it("allows executing → reviewing", () => {
		expect(() => validateTransition(EXECUTING, REVIEWING)).not.toThrow();
	});

	it("allows reviewing → executed", () => {
		expect(() => validateTransition(REVIEWING, EXECUTED)).not.toThrow();
	});

	it("allows executed → merged", () => {
		expect(() => validateTransition(EXECUTED, MERGED)).not.toThrow();
	});

	it("rejects executed → executing (backwards)", () => {
		expect(() => validateTransition(EXECUTED, EXECUTING)).toThrow(/invalid transition/i);
	});

	it("rejects merged → planned (backwards)", () => {
		expect(() => validateTransition(MERGED, PLANNED)).toThrow(/invalid transition/i);
	});

	it("rejects planned → merged (skip)", () => {
		expect(() => validateTransition(PLANNED, MERGED)).toThrow(/invalid transition/i);
	});

	it("rejects unknown label", () => {
		expect(() => validateTransition("unknown:label", EXECUTING)).toThrow(/invalid transition/i);
	});
});

describe("setMetadata", () => {
	it("executes bd update --set-metadata with correct args", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await setMetadata("issue-1", "phase", "executing", { exec });
		expect(exec).toHaveBeenCalledWith(`bd update "issue-1" --set-metadata phase=executing`);
	});
});

describe("getMetadata", () => {
	it("returns the value when key exists", async () => {
		const exec = vi
			.fn<(cmd: string) => Promise<string>>()
			.mockResolvedValue(JSON.stringify({ data: [{ metadata: { phase: "executing" } }] }));
		const result = await getMetadata("issue-1", "phase", { exec });
		expect(result).toBe("executing");
	});

	it("returns undefined when key does not exist", async () => {
		const exec = vi
			.fn<(cmd: string) => Promise<string>>()
			.mockResolvedValue(JSON.stringify({ data: [{ metadata: { other_key: "value" } }] }));
		const result = await getMetadata("issue-1", "phase", { exec });
		expect(result).toBeUndefined();
	});

	it("returns undefined when metadata is empty", async () => {
		const exec = vi
			.fn<(cmd: string) => Promise<string>>()
			.mockResolvedValue(JSON.stringify({ data: [{}] }));
		const result = await getMetadata("issue-1", "phase", { exec });
		expect(result).toBeUndefined();
	});

	it("executes bd show --json with correct issue", async () => {
		const exec = vi
			.fn<(cmd: string) => Promise<string>>()
			.mockResolvedValue(JSON.stringify({ data: [{}] }));
		await getMetadata("issue-1", "phase", { exec });
		expect(exec).toHaveBeenCalledWith(`bd show "issue-1" --json`);
	});
});

describe("cleanupAllSandcastleLabels", () => {
	it("removes each sandcastle label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValueOnce("sandcastle:planned\nsandcastle:executing\nother:label\n");

		await cleanupAllSandcastleLabels({ exec });

		expect(exec).toHaveBeenCalledWith("bd label list-all");
		expect(exec).toHaveBeenCalledWith("bd label remove sandcastle:planned");
		expect(exec).toHaveBeenCalledWith("bd label remove sandcastle:executing");
		expect(exec).not.toHaveBeenCalledWith("bd label remove other:label");
	});

	it("does nothing when no sandcastle labels exist", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>();
		exec.mockResolvedValueOnce("other:label\nanother:tag\n");

		await cleanupAllSandcastleLabels({ exec });

		expect(exec).toHaveBeenCalledTimes(1); // only list-all
		expect(exec).toHaveBeenCalledWith("bd label list-all");
	});
});

describe("removeLabel", () => {
	it("executes bd label remove with correct issue and label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await removeLabel("issue-1", PLANNED, { exec });
		expect(exec).toHaveBeenCalledWith(`bd label remove "issue-1" ${PLANNED}`);
	});
});

describe("revertPhaseLabel", () => {
	it("steps back from executing to planned", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await revertPhaseLabel("issue-1", EXECUTING, { exec });
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${PLANNED}`);
	});

	it("steps back from reviewing to executing", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await revertPhaseLabel("issue-1", REVIEWING, { exec });
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${EXECUTING}`);
	});

	it("steps back from executed to reviewing", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await revertPhaseLabel("issue-1", EXECUTED, { exec });
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${REVIEWING}`);
	});

	it("strips planned label (back to open) when label is planned", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await revertPhaseLabel("issue-1", PLANNED, { exec });
		expect(exec).toHaveBeenCalledWith(`bd label remove "issue-1" ${PLANNED}`);
	});

	it("does nothing for unknown label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		await revertPhaseLabel("issue-1", "unknown:label", { exec });
		expect(exec).not.toHaveBeenCalled();
	});
});
