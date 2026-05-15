import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const servicePath = ".sandcastle/systemd/sandcastle.service";
const readmePath = ".sandcastle/systemd/README.md";

describe("sandcastle.service", () => {
	const content = readFileSync(servicePath, "utf-8");

	it("declares TimeoutStopSec=630 (10min + 30s buffer)", () => {
		expect(content).toContain("TimeoutStopSec=630");
	});

	it("contains no stale MAX_ITERATIONS references", () => {
		expect(content).not.toMatch(/MAX_ITERATIONS/i);
	});
});

describe("systemd README.md", () => {
	const content = readFileSync(readmePath, "utf-8");

	it("contains no stale MAX_ITERATIONS references", () => {
		expect(content).not.toMatch(/MAX_ITERATIONS/i);
	});

	it("documents the infinite poll loop", () => {
		expect(content).toMatch(/while\s*\(\s*true\s*\)|infinite|runs indefinitely/i);
	});

	it("documents SIGTERM / graceful shutdown behavior", () => {
		expect(content).toMatch(/SIGTERM|graceful shutdown|shutdown/i);
	});

	it("documents heartbeat logs", () => {
		expect(content).toMatch(/heartbeat/i);
	});

	it("documents journalctl for reading logs", () => {
		expect(content).toMatch(/journalctl/i);
	});

	it("documents pino JSON log format", () => {
		expect(content).toMatch(/pino|JSON log/i);
	});
});
