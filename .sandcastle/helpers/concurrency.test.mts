import assert from "assert";
import { runWithConcurrencyLimit } from "./concurrency.mts";

// ---------------------------------------------------------------------------
// Processes all items and returns results in order
// ---------------------------------------------------------------------------

const items1 = [1, 2, 3];
const results1 = await runWithConcurrencyLimit(items1, 2, async (item) => {
  return item * 2;
});

assert.strictEqual(results1.length, 3, "should return 3 results");
assert.deepStrictEqual(results1[0], { status: "fulfilled", value: 2 }, "result 0 should be 2");
assert.deepStrictEqual(results1[1], { status: "fulfilled", value: 4 }, "result 1 should be 4");
assert.deepStrictEqual(results1[2], { status: "fulfilled", value: 6 }, "result 2 should be 6");

// ---------------------------------------------------------------------------
// Respects the concurrency limit
// ---------------------------------------------------------------------------

let running = 0;
let maxRunning = 0;

const items2 = [1, 2, 3, 4, 5];
const results2 = await runWithConcurrencyLimit(items2, 2, async (item) => {
  running++;
  maxRunning = Math.max(maxRunning, running);
  await new Promise((resolve) => setTimeout(resolve, 10));
  running--;
  return item;
});

assert.strictEqual(maxRunning, 2, "max concurrency should be 2");
assert.strictEqual(results2.length, 5, "should return 5 results");
for (let i = 0; i < 5; i++) {
  assert.deepStrictEqual(results2[i], { status: "fulfilled", value: items2[i] }, `result ${i} should match`);
}

// ---------------------------------------------------------------------------
// Settles all promises even when some reject
// ---------------------------------------------------------------------------

const items3 = [1, 2, 3];
const results3 = await runWithConcurrencyLimit(items3, 2, async (item) => {
  if (item === 2) {
    throw new Error("boom");
  }
  return item * 10;
});

assert.strictEqual(results3.length, 3, "should return 3 results");
assert.deepStrictEqual(results3[0], { status: "fulfilled", value: 10 }, "result 0 should be 10");
assert.strictEqual(results3[1].status, "rejected", "result 1 should be rejected");
assert.deepStrictEqual(results3[2], { status: "fulfilled", value: 30 }, "result 2 should be 30");

console.log("All concurrency tests passed!");
