import { describe, expect, it, vi } from "vitest";
import type { NotificationSummary } from "./notifier.mts";
import { NotifierRegistry, NtfyNotifier } from "./notifier.mts";

// ---------------------------------------------------------------------------
// NtfyNotifier
// ---------------------------------------------------------------------------

describe("NtfyNotifier", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts JSON to the configured topic URL", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/mytopic",
			fetchMock as unknown as typeof globalThis.fetch,
		);

		await notifier.send({
			level: "info",
			title: "Merge complete",
			message: "Branch fix-auth was merged",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://ntfy.sh/mytopic");
		expect(opts.method).toBe("POST");
		expect(opts.headers).toMatchObject({
			"Content-Type": "application/json",
		});
	});

	it("sends the correct JSON body with topic, title, message, and tags", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/mytopic",
			fetchMock as unknown as typeof globalThis.fetch,
		);

		await notifier.send({
			level: "warn",
			title: "Merge failed",
			message: "Branch fix-auth could not be merged",
			tags: ["merge", "sandcastle"],
		});

		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.topic).toBe("mytopic");
		expect(body.title).toBe("Merge failed");
		expect(body.message).toBe("Branch fix-auth could not be merged");
		expect(body.tags).toEqual(["merge", "sandcastle"]);
	});

	it("maps info/warn/error to ntfy priority levels", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/mytopic",
			fetchMock as unknown as typeof globalThis.fetch,
		);

		await notifier.send({ level: "info", title: "Info", message: "test" });
		await notifier.send({ level: "warn", title: "Warn", message: "test" });
		await notifier.send({ level: "error", title: "Error", message: "test" });

		const calls = fetchMock.mock.calls as [string, RequestInit][];
		const bodies = calls.map(([, opts]) => JSON.parse(opts.body as string));
		expect(bodies[0].priority).toBe(3); // info → default priority
		expect(bodies[1].priority).toBe(4); // warn → high priority
		expect(bodies[2].priority).toBe(5); // error → urgent priority
	});

	it("defaults tags to empty array if not provided", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/mytopic",
			fetchMock as unknown as typeof globalThis.fetch,
		);

		await notifier.send({ level: "info", title: "Test", message: "No tags" });

		const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.tags).toEqual([]);
	});

	it("does not throw when HTTP request fails (fire-and-forget)", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/mytopic",
			fetchMock as unknown as typeof globalThis.fetch,
		);

		await expect(
			notifier.send({ level: "error", title: "Fail", message: "test" }),
		).resolves.toBeUndefined();
	});

	it("does not throw when fetch throws a network error (fire-and-forget)", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/mytopic",
			fetchMock as unknown as typeof globalThis.fetch,
		);

		await expect(
			notifier.send({ level: "info", title: "Network fail", message: "test" }),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// NotifierRegistry
// ---------------------------------------------------------------------------

describe("NotifierRegistry", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches to all registered notifiers", async () => {
		const fetch1 = vi.fn().mockResolvedValue({ ok: true } as Response);
		const fetch2 = vi.fn().mockResolvedValue({ ok: true } as Response);
		const n1 = new NtfyNotifier(
			"https://ntfy.sh/topic1",
			fetch1 as unknown as typeof globalThis.fetch,
		);
		const n2 = new NtfyNotifier(
			"https://ntfy.sh/topic2",
			fetch2 as unknown as typeof globalThis.fetch,
		);

		const registry = new NotifierRegistry([n1, n2]);

		await registry.send({ level: "info", title: "Test", message: "Dispatch test" });

		expect(fetch1).toHaveBeenCalledTimes(1);
		expect(fetch2).toHaveBeenCalledTimes(1);
	});

	it("continues dispatching when one notifier fails", async () => {
		const fetch1 = vi.fn().mockRejectedValue(new Error("First notifier fails"));
		const fetch2 = vi.fn().mockResolvedValue({ ok: true } as Response);
		const failingNotifier = new NtfyNotifier(
			"https://ntfy.sh/bad-topic",
			fetch1 as unknown as typeof globalThis.fetch,
		);
		const goodNotifier = new NtfyNotifier(
			"https://ntfy.sh/good-topic",
			fetch2 as unknown as typeof globalThis.fetch,
		);

		const registry = new NotifierRegistry([failingNotifier, goodNotifier]);

		await expect(
			registry.send({ level: "info", title: "Test", message: "Partial failure" }),
		).resolves.toBeUndefined();

		expect(fetch2).toHaveBeenCalledTimes(1);
	});

	it("works with zero notifiers (no-op)", async () => {
		const registry = new NotifierRegistry([]);

		await expect(
			registry.send({ level: "info", title: "No-op", message: "nothing" }),
		).resolves.toBeUndefined();
	});

	it("supports adding notifiers after construction", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
		const notifier = new NtfyNotifier(
			"https://ntfy.sh/late-topic",
			fetchMock as unknown as typeof globalThis.fetch,
		);
		const registry = new NotifierRegistry([]);

		registry.add(notifier);
		await registry.send({ level: "info", title: "Late add", message: "test" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// NotificationSummary validation
// ---------------------------------------------------------------------------

describe("NotificationSummary interface contract", () => {
	it("accepts valid NotificationSummary shapes", () => {
		const summaries: NotificationSummary[] = [
			{ level: "info", title: "Test", message: "Test message" },
			{ level: "warn", title: "Warn", message: "Warn message", tags: ["tag1"] },
			{ level: "error", title: "Error", message: "Error message", tags: [] },
		];
		expect(summaries).toHaveLength(3);
	});
});
