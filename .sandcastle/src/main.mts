// Sandcastle daemon — four-phase poll loop (Plan → Execute → Merge).
// Runs indefinitely; SIGTERM triggers graceful shutdown after current iteration.

import * as sandcastle from "@ai-hero/sandcastle";
import {
	copyToWorktree,
	GRACEFUL_SHUTDOWN_MS,
	hooks,
	logger,
	MAX_PARALLEL_TASKS,
	POLL_INTERVAL_MS,
	sandboxProvider,
} from "./config.mts";
import { waitForOpenIssues } from "./helpers/issues.mts";
import { createNotifierFromEnv } from "./helpers/notifier.mts";
import { runExecutionPhase } from "./phases/execute.mts";
import { runMergePhase } from "./phases/merge.mts";
import { runPlanner } from "./phases/plan.mts";
import type { PlannerIssue } from "./types.mts";

// ---------------------------------------------------------------------------
// Notifier (optional — null when NTFY_TOPIC_URL is not set)
// ---------------------------------------------------------------------------

const notifier = createNotifierFromEnv();
if (notifier) {
	logger.info("Notifier enabled via NTFY_TOPIC_URL");
} else {
	logger.info("Notifier disabled — set NTFY_TOPIC_URL to enable ntfy.sh notifications");
}

export async function main(): Promise<void> {
	process.on("unhandledRejection", (reason) =>
		logger.error({ err: reason }, "Unhandled rejection — caught by safety net"),
	);

	let shouldShutdown = false;
	process.on("SIGTERM", () => {
		logger.info("SIGTERM received — will shut down after current iteration");
		shouldShutdown = true;
		setTimeout(() => {
			logger.fatal("Graceful shutdown timeout — forcing exit");
			process.exit(1);
		}, GRACEFUL_SHUTDOWN_MS).unref();
	});

	let iteration = 0;
	while (true) {
		iteration++;
		logger.info({ iteration }, "Heartbeat — starting iteration");

		const openIssues = await waitForOpenIssues(POLL_INTERVAL_MS, logger);
		logger.info({ count: openIssues.length, iteration }, "Poll complete");

		// Phase 1: Plan
		let issues: PlannerIssue[];
		try {
			issues = await runPlanner(sandcastle.run, sandboxProvider, hooks, logger);
		} catch (err) {
			logger.error({ err }, "Plan phase failed — exiting");
			const errMsg = err instanceof Error ? err.message.slice(0, 500) : String(err);
			notifier
				?.send({
					level: "error",
					title: "Plan phase failed",
					message: `Planning phase failed: ${errMsg}`,
					tags: ["plan", "sandcastle", "error"],
				})
				.catch(() => {});
			break;
		}

		if (issues.length === 0) {
			logger.info("No unblocked issues — exiting");
			break;
		}

		// Phase 2: Execute + Review
		let completed: PlannerIssue[];
		try {
			completed = await runExecutionPhase(
				issues,
				sandcastle.createSandbox,
				sandboxProvider,
				hooks,
				copyToWorktree,
				MAX_PARALLEL_TASKS,
				logger,
				undefined,
				notifier ?? undefined,
			);
		} catch (err) {
			logger.error({ err }, "Execute phase failed — continuing");
			const errMsg = err instanceof Error ? err.message.slice(0, 500) : String(err);
			notifier
				?.send({
					level: "error",
					title: "Execute phase failed",
					message: `Execution phase failed: ${errMsg}`,
					tags: ["execute", "sandcastle", "error"],
				})
				.catch(() => {});
			continue;
		}

		const branches = completed.map((i) => i.branch);
		logger.info({ count: branches.length }, "Execution complete");
		for (const b of branches) logger.info(`  ${b}`);

		if (branches.length === 0) {
			logger.info("No commits produced. Skipping merge.");
			continue;
		}

		// Phase 3: Merge
		try {
			await runMergePhase(
				sandcastle.run,
				completed,
				sandboxProvider,
				hooks,
				logger,
				undefined,
				notifier ?? undefined,
			);
		} catch (err) {
			logger.error({ err }, "Merge phase failed — continuing");
			notifier
				?.send({
					level: "error",
					title: "Merge phase failed",
					message: `Merge phase failed: ${err instanceof Error ? err.message.slice(0, 500) : String(err)}`,
					tags: ["merge", "sandcastle", "error"],
				})
				.catch(() => {});
			continue;
		}

		logger.info("Branches merged.");

		if (shouldShutdown) {
			logger.info("Graceful shutdown — iteration complete");
			break;
		}
	}
}

main().catch((err) => {
	logger.fatal({ err }, "Fatal error — exiting");
	process.exit(1);
});
