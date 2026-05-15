/**
 * Effect.ts pipeline assembly — wires the execute → merge → verify flow
 * through a bounded Queue so merge starts as soon as the first execution
 * completes (no batch barrier).
 *
 * Architecture:
 *
 *   Queue.bounded ──┬── Producer fiber (Effect.forEach, concurrency:N)
 *                   │      executeOneIssue → if commits → offer queue
 *                   │
 *                   ├── Direct-merge producer (Effect.forEach)
 *                   │      offer mergeIssues into queue immediately
 *                   │
 *                   ├── Verification fiber (Effect.forEach, concurrency:3)
 *                   │      verify merged-but-unclosed tickets
 *                   │
 *                   └── Consumer fiber (forkDaemon, gen loop with Queue.take)
 *                          drains items as they arrive, exits on sentinel
 *
 *   After producers finish, a sentinel value is offered to signal
 *   end-of-stream. The consumer exits cleanly. No Queue.shutdown needed —
 *   avoids Effect 3.21.2 bug where takeBetween checks shutdownFlag before
 *   polling buffered items, losing items that were already in the queue.
 */

import { Effect, Fiber, Queue } from "effect";
import type { Logger } from "pino";
import type { SandboxRunResult } from "@ai-hero/sandcastle";
import type { PlannerIssue } from "../types.mts";

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

/** Unique sentinel signalling end-of-stream to the consumer. */
const PIPELINE_END = Symbol("pipeline-end");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that runs execute+review for a single issue. */
export type ExecuteIssueFn = (issue: PlannerIssue) => Promise<SandboxRunResult>;

/** Function that merges a single branch (issue already executed). */
export type MergeIssueFn = (issue: PlannerIssue) => Promise<void>;

/** Function that runs safety-net verification for a single merged-labeled issue. */
export type VerifyIssueFn = (issue: PlannerIssue) => Promise<void>;

export interface PipelineDeps {
	/** Issues that need execution + review. */
	executeIssues: PlannerIssue[];
	/** Issues already executed (from resume routing) that go straight to merge. */
	mergeIssues: PlannerIssue[];
	/** Issues labeled merged that need safety-net verification. */
	mergedIssues: PlannerIssue[];
	executeOne: ExecuteIssueFn;
	mergeOne: MergeIssueFn;
	verifyOne: VerifyIssueFn;
	maxParallelTasks: number;
	logger?: Logger;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full execute → merge → verify pipeline via an Effect.ts Queue.
 *
 * Executions run concurrently (bounded by maxParallelTasks). When an issue
 * produces commits (or is skipImplementer), it is offered to the queue.
 * Direct-to-merge issues (from resume routing) are offered immediately.
 * Verification of merged-labeled issues runs in parallel (concurrency: 3).
 *
 * The merge consumer is a daemon fiber that drains the queue as items arrive.
 * After all producers finish, a sentinel value signals end-of-stream,
 * cleanly terminating the consumer.
 */
export async function runPipeline(deps: PipelineDeps): Promise<void> {
	const {
		executeIssues,
		mergeIssues,
		mergedIssues,
		executeOne,
		mergeOne,
		verifyOne,
		maxParallelTasks,
		logger,
	} = deps;

	// Queue with capacity large enough to buffer all pending issues.
	// Uses unknown sentinel cast so consumer can check with ===.
	const queue = await Effect.runPromise(Queue.bounded<PlannerIssue>(64));

	// ---- Consumer fiber ----
	// Runs as daemon with direct Queue.take in a gen loop.
	// Exits cleanly when it receives the PIPELINE_END sentinel.
	const consumer = Effect.gen(function* () {
		while (true) {
			const item = yield* Queue.take(queue);
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (item === (PIPELINE_END as unknown)) break;
			const issue = item as PlannerIssue;

			// Merge with per-branch error boundary
			const mergeResult = yield* Effect.either(
				Effect.tryPromise({
					try: () => mergeOne(issue),
					catch: (err) => err,
				}),
			);

			if (mergeResult._tag === "Left") {
				logger?.error(
					{ err: mergeResult.left, branch: issue.branch, issueId: issue.id },
					"Consumer: merge error (non-fatal)",
				);
			}
		}
	});

	// ---- Producer fiber ----
	// Effect.forEach runs executeOneIssue concurrently. Per-issue error
	// boundary ensures one crash never touches other issues.
	const producer = Effect.forEach(
		executeIssues,
		(issue) =>
			Effect.tryPromise({
				try: () => executeOne(issue),
				catch: (err) => err,
			}).pipe(
				Effect.flatMap((result) => {
					if (result instanceof Error) return Effect.void;
					const hasCommits =
						issue.skipImplementer ||
						(result as SandboxRunResult).commits.length > 0;
					if (hasCommits) {
						return Queue.offer(queue, issue).pipe(Effect.asVoid);
					}
					return Effect.void;
				}),
				Effect.catchAll((err) => {
					logger?.error({ err }, "Producer fiber: unexpected error (non-fatal)");
					return Effect.void;
				}),
			),
		{ concurrency: maxParallelTasks },
	);

	// ---- Direct-to-merge producer ----
	// Issues routed straight to merge go into the queue immediately.
	const directMergeProducer = Effect.forEach(
		mergeIssues,
		(issue) =>
			Queue.offer(queue, issue).pipe(
				Effect.asVoid,
				Effect.catchAll(() => Effect.void),
			),
		{ concurrency: maxParallelTasks },
	);

	// ---- Verification fiber ----
	// Parallel safety-net verification for merged-labeled issues.
	const verifier = Effect.forEach(
		mergedIssues,
		(issue) =>
			Effect.tryPromise({
				try: () => verifyOne(issue),
				catch: (err) => err,
			}).pipe(
				Effect.catchAll((err) => {
					logger?.error(
						{ err, issueId: issue.id, branch: issue.branch },
						"Verification fiber: verify error (non-fatal)",
					);
					return Effect.void;
				}),
			),
		{ concurrency: 3 },
	);

	// ---- Orchestration ----
	// 1. Fork consumer daemon — starts draining as items arrive.
	// 2. Fork verifier daemon.
	// 3. Run all producers concurrently.
	// 4. Offer sentinel — consumer exits cleanly.
	// 5. Join both fibers.
	const program = Effect.gen(function* () {
		const consumerFiber = yield* Effect.forkDaemon(consumer);
		const verifierFiber = yield* Effect.forkDaemon(verifier);

		// Run producers concurrently
		yield* Effect.all(
			[directMergeProducer, producer],
			{ concurrency: "inherit" },
		);

		// Signal end-of-stream — consumer will drain and exit
		yield* Queue.offer(queue, PIPELINE_END as unknown as PlannerIssue);

		// Join fibers
		yield* Fiber.join(consumerFiber);
		yield* Fiber.join(verifierFiber);
	});

	await Effect.runPromise(program);
}
