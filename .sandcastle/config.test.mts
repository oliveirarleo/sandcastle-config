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

assert.strictEqual(
  readOpencodeApiKey(path.join(tmpDir, "missing.json")),
  undefined,
  "should return undefined for a missing file",
);

const badJson = path.join(tmpDir, "bad.json");
fs.writeFileSync(badJson, "not json");
assert.strictEqual(
  readOpencodeApiKey(badJson),
  undefined,
  "should return undefined for invalid JSON",
);

const missingKey = path.join(tmpDir, "missing-key.json");
fs.writeFileSync(missingKey, JSON.stringify({ other: "value" }));
assert.strictEqual(
  readOpencodeApiKey(missingKey),
  undefined,
  "should return undefined when the key is missing",
);

const goodFile = path.join(tmpDir, "good.json");
fs.writeFileSync(
  goodFile,
  JSON.stringify({ "opencode-go": { key: "secret123" } }),
);
assert.strictEqual(
  readOpencodeApiKey(goodFile),
  "secret123",
  "should return the key when it exists",
);

fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

assert.strictEqual(MAX_ITERATIONS, 10, "MAX_ITERATIONS should be 10");

assert.strictEqual(
  typeof MAX_PARALLEL_TASKS,
  "number",
  "MAX_PARALLEL_TASKS should be a number",
);
assert.strictEqual(
  MAX_PARALLEL_TASKS > 0,
  true,
  "MAX_PARALLEL_TASKS should be positive",
);

assert.strictEqual(
  typeof POLL_INTERVAL_MS,
  "number",
  "POLL_INTERVAL_MS should be a number",
);
assert.strictEqual(
  POLL_INTERVAL_MS > 0,
  true,
  "POLL_INTERVAL_MS should be positive",
);

console.log("All config tests passed!");
