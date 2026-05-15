/**
 * Generic notification system for the sandcastle orchestrator.
 *
 * Provides a pluggable `Notifier` interface with an ntfy.sh backend as the
 * first implementation. Use the {@link NotifierRegistry} to compose multiple
 * backends.
 *
 * All notification sends are fire-and-forget — a failure to send a
 * notification must never crash or block the orchestrator loop.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationSummary {
	level: "info" | "warn" | "error";
	title: string;
	message: string;
	tags?: string[];
}

// ---------------------------------------------------------------------------
// Notifier interface
// ---------------------------------------------------------------------------

export interface Notifier {
	send(summary: NotificationSummary): Promise<void>;
}

// ---------------------------------------------------------------------------
// NtfyNotifier
// ---------------------------------------------------------------------------

/**
 * ntfy.sh integer priority map.
 *   1 = min, 2 = low, 3 = default, 4 = high, 5 = urgent
 */
const LEVEL_PRIORITY: Record<NotificationSummary["level"], number> = {
	info: 3,
	warn: 4,
	error: 5,
};

/**
 * Parse the topic name from an ntfy.sh URL.
 * e.g. "https://ntfy.sh/mytopic" → "mytopic"
 */
function parseTopic(topicUrl: string): string {
	return new URL(topicUrl).pathname.replace(/^\//, "");
}

/**
 * Ntfy.sh backend for the {@link Notifier} interface.
 *
 * Posts JSON notifications to a ntfy.sh topic URL. The topic is parsed from
 * the URL path. Priority is mapped from the notification level.
 */
export class NtfyNotifier implements Notifier {
	private readonly topicUrl: string;
	private readonly topic: string;
	private readonly fetchFn: typeof globalThis.fetch;

	constructor(topicUrl: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
		this.topicUrl = topicUrl;
		this.topic = parseTopic(topicUrl);
		this.fetchFn = fetchFn;
	}

	async send(summary: NotificationSummary): Promise<void> {
		try {
			const body = JSON.stringify({
				topic: this.topic,
				title: summary.title,
				message: summary.message,
				tags: summary.tags ?? [],
				priority: LEVEL_PRIORITY[summary.level],
			});

			const response = await this.fetchFn(this.topicUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});

			if (!response.ok) {
				console.warn(
					`[NtfyNotifier] HTTP ${response.status} for ${summary.title}: ${response.statusText}`,
				);
			}
		} catch (err) {
			console.warn(`[NtfyNotifier] send failed for "${summary.title}":`, err);
		}
	}
}

// ---------------------------------------------------------------------------
// NotifierRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that holds one or more {@link Notifier} instances.
 *
 * Dispatches every notification to all registered backends. A failure in one
 * backend does not cancel delivery to other backends.
 */
export class NotifierRegistry implements Notifier {
	private readonly notifiers: Notifier[];

	constructor(notifiers: Notifier[] = []) {
		this.notifiers = [...notifiers];
	}

	add(notifier: Notifier): void {
		this.notifiers.push(notifier);
	}

	async send(summary: NotificationSummary): Promise<void> {
		await Promise.allSettled(this.notifiers.map((n) => n.send(summary)));
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link NotifierRegistry} from the `NTFY_TOPIC_URL` environment
 * variable. Returns `undefined` when the env var is not set.
 *
 * Usage:
 * ```ts
 * const notifier = createNotifierFromEnv();
 * if (notifier) {
 *   await notifier.send({ level: 'info', title: '...', message: '...' });
 * }
 * ```
 */
export function createNotifierFromEnv(): NotifierRegistry | undefined {
	const topicUrl = process.env.NTFY_TOPIC_URL;
	if (!topicUrl) {
		return undefined;
	}
	return new NotifierRegistry([new NtfyNotifier(topicUrl)]);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Format an unknown error into a notification-safe message (max 500 chars). */
export function formatErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}
