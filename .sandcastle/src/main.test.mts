import { describe, expect, it, vi } from "vitest";
import {
	classifyResumeLabel,
	EXECUTED,
	EXECUTING,
	MERGED,
	PLANNED,
	REVIEWING,
	shouldSkipPlanner,
} from "./helpers/labels.mts";
import { createLabelCallbacks } from "./main.mts";
import type { BeadsIssue } from "./types.mts";

// ---------------------------------------------------------------------------
// shouldSkipPlanner
// ---------------------------------------------------------------------------

describe("shouldSkipPlanner", () => {
	it("returns false when no issues have sandcastle labels", () => {
		const issues: BeadsIssue[] = [
			{ id: "a", title: "T", status: "open", labels: [] },
			{ id: "b", title: "T", status: "open", labels: ["ready-for-agent"] },
		];
		expect(shouldSkipPlanner(issues)).toBe(false);
	});

	it("returns false when all sandcastle labels are planned only", () => {
		const issues: BeadsIssue[] = [
			{ id: "a", title: "T", status: "open", labels: [PLANNED] },
			{ id: "b", title: "T", status: "open", labels: [PLANNED, "ready-for-agent"] },
		];
		expect(shouldSkipPlanner(issues)).toBe(false);
	});

	it("returns true when any issue has executing label", () => {
		const issues: BeadsIssue[] = [
			{ id: "a", title: "T", status: "open", labels: [PLANNED] },
			{ id: "b", title: "T", status: "open", labels: [EXECUTING] },
		];
		expect(shouldSkipPlanner(issues)).toBe(true);
	});

	it("returns true when any issue has reviewing label", () => {
		const issues: BeadsIssue[] = [{ id: "a", title: "T", status: "open", labels: [REVIEWING] }];
		expect(shouldSkipPlanner(issues)).toBe(true);
	});

	it("returns true when any issue has executed label", () => {
		const issues: BeadsIssue[] = [{ id: "a", title: "T", status: "open", labels: [EXECUTED] }];
		expect(shouldSkipPlanner(issues)).toBe(true);
	});

	it("returns true when any issue has merged label (should skip entirely)", () => {
		const issues: BeadsIssue[] = [{ id: "a", title: "T", status: "open", labels: [MERGED] }];
		expect(shouldSkipPlanner(issues)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// classifyResumeLabel
// ---------------------------------------------------------------------------

describe("classifyResumeLabel", () => {
	function issue(labels: string[]): BeadsIssue {
		return { id: "test", title: "T", status: "open", labels };
	}

	it("returns 'execute' for planned label", () => {
		expect(classifyResumeLabel(issue([PLANNED]))).toBe("execute");
	});

	it("returns 'execute' for executing label", () => {
		expect(classifyResumeLabel(issue([EXECUTING]))).toBe("execute");
	});

	it("returns 'execute' for reviewing label", () => {
		expect(classifyResumeLabel(issue([REVIEWING]))).toBe("execute");
	});

	it("returns 'merge' for executed label", () => {
		expect(classifyResumeLabel(issue([EXECUTED]))).toBe("merge");
	});

	it("returns 'skip' for merged label", () => {
		expect(classifyResumeLabel(issue([MERGED]))).toBe("skip");
	});

	it("returns 'skip' when no sandcastle labels present", () => {
		expect(classifyResumeLabel(issue(["other-label"]))).toBe("skip");
	});

	it("prefers later-state labels when multiple sandcastle labels present", () => {
		// executing + executed → executed is later, so 'merge'
		expect(classifyResumeLabel(issue([EXECUTING, EXECUTED]))).toBe("merge");
	});

	it("executed takes priority over planned", () => {
		expect(classifyResumeLabel(issue([PLANNED, EXECUTED]))).toBe("merge");
	});
});

// ---------------------------------------------------------------------------
// createLabelCallbacks
// ---------------------------------------------------------------------------

describe("createLabelCallbacks", () => {
	it("onImplementStart adds EXECUTING label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onImplementStart?.("issue-1");
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${EXECUTING}`);
	});

	it("onReviewStart adds REVIEWING label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onReviewStart?.("issue-1");
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${REVIEWING}`);
	});

	it("onExecuteComplete adds EXECUTED label", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onExecuteComplete?.("issue-1");
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${EXECUTED}`);
	});

	it("onImplementSession persists session ID", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onImplementSession?.("issue-1", "session-abc");
		expect(exec).toHaveBeenCalledWith(
			`bd update "issue-1" --set-metadata implementSession=session-abc`,
		);
	});

	it("onImplementSession does nothing when sessionId is undefined", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onImplementSession?.("issue-1", undefined);
		expect(exec).not.toHaveBeenCalled();
	});

	it("onReviewSession persists session ID", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onReviewSession?.("issue-1", "session-xyz");
		expect(exec).toHaveBeenCalledWith(
			`bd update "issue-1" --set-metadata reviewSession=session-xyz`,
		);
	});

	it("onReviewSession does nothing when sessionId is undefined", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onReviewSession?.("issue-1", undefined);
		expect(exec).not.toHaveBeenCalled();
	});

	it("onValidateSession returns true by default", async () => {
		const callbacks = createLabelCallbacks();
		const result = await callbacks.onValidateSession?.("any-session-id");
		expect(result).toBe(true);
	});

	it("onCrash calls revertPhaseLabel", async () => {
		const exec = vi.fn<(cmd: string) => Promise<string>>().mockResolvedValue("");
		const callbacks = createLabelCallbacks({ exec });
		await callbacks.onCrash?.("issue-1", EXECUTING);
		// Revert from executing -> planned
		expect(exec).toHaveBeenCalledWith(`bd label add "issue-1" ${PLANNED}`);
	});
});
