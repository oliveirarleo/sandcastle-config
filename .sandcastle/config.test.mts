import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	MAX_ITERATIONS,
	MAX_PARALLEL_TASKS,
	POLL_INTERVAL_MS,
	readOpencodeApiKey,
	resolveHostPath,
} from "./config.mts";

describe("resolveHostPath", () => {
	it("returns absolute paths unchanged", () => {
		expect(resolveHostPath("/absolute/path")).toBe("/absolute/path");
	});

	it("expands ~ to home directory", () => {
		expect(resolveHostPath("~/relative")).toBe(
			path.join(os.homedir(), "relative"),
		);
	});

	it("returns plain paths unchanged", () => {
		expect(resolveHostPath("plain")).toBe("plain");
	});
});

describe("readOpencodeApiKey", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined for a missing file", () => {
		expect(
			readOpencodeApiKey(path.join(tmpDir, "missing.json")),
		).toBeUndefined();
	});

	it("returns undefined for invalid JSON", () => {
		const badJson = path.join(tmpDir, "bad.json");
		fs.writeFileSync(badJson, "not json");
		expect(readOpencodeApiKey(badJson)).toBeUndefined();
	});

	it("returns undefined when the key is missing", () => {
		const missingKey = path.join(tmpDir, "missing-key.json");
		fs.writeFileSync(missingKey, JSON.stringify({ other: "value" }));
		expect(readOpencodeApiKey(missingKey)).toBeUndefined();
	});

	it("returns the key when it exists", () => {
		const goodFile = path.join(tmpDir, "good.json");
		fs.writeFileSync(
			goodFile,
			JSON.stringify({ "opencode-go": { key: "secret123" } }),
		);
		expect(readOpencodeApiKey(goodFile)).toBe("secret123");
	});
});

describe("constants", () => {
	it("MAX_ITERATIONS is 10", () => {
		expect(MAX_ITERATIONS).toBe(10);
	});

	it("MAX_PARALLEL_TASKS is a positive number", () => {
		expect(MAX_PARALLEL_TASKS).toBeGreaterThan(0);
	});

	it("POLL_INTERVAL_MS is a positive number", () => {
		expect(POLL_INTERVAL_MS).toBeGreaterThan(0);
	});
});
