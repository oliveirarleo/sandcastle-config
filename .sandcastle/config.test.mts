import assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveHostPath,
  readOpencodeApiKey,
  MAX_ITERATIONS,
  MAX_PARALLEL_TASKS,
  POLL_INTERVAL_MS,
} from "./config.mts";

// ---------------------------------------------------------------------------
// resolveHostPath
// ---------------------------------------------------------------------------

assert.strictEqual(resolveHostPath("/absolute/path"), "/absolute/path");
assert.strictEqual(
  resolveHostPath("~/relative"),
  path.join(os.homedir(), "relative"),
);
assert.strictEqual(resolveHostPath("plain"), "plain");

// ---------------------------------------------------------------------------
// readOpencodeApiKey
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));

// Returns undefined when the file does not exist.
assert.strictEqual(readOpencodeApiKey(path.join(tmpDir, "missing.json")), undefined);

// Returns undefined when the file is not valid JSON.
const badJson = path.join(tmpDir, "bad.json");
fs.writeFileSync(badJson, "not json");
assert.strictEqual(readOpencodeApiKey(badJson), undefined);

// Returns undefined when the key is missing.
const missingKey = path.join(tmpDir, "missing-key.json");
fs.writeFileSync(missingKey, JSON.stringify({ other: "value" }));
assert.strictEqual(readOpencodeApiKey(missingKey), undefined);

// Returns the key when it exists.
const goodFile = path.join(tmpDir, "good.json");
fs.writeFileSync(goodFile, JSON.stringify({ "opencode-go": { key: "secret123" } }));
assert.strictEqual(readOpencodeApiKey(goodFile), "secret123");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

assert.strictEqual(typeof MAX_ITERATIONS, "number");
assert.strictEqual(MAX_ITERATIONS > 0, true);

assert.strictEqual(typeof MAX_PARALLEL_TASKS, "number");
assert.strictEqual(MAX_PARALLEL_TASKS > 0, true);

assert.strictEqual(typeof POLL_INTERVAL_MS, "number");
assert.strictEqual(POLL_INTERVAL_MS > 0, true);

console.log("All config tests passed!");
