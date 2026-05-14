import assert from "assert";
import { getOpenIssues, waitForOpenIssues } from "./issues.mts";

// ---------------------------------------------------------------------------
// getOpenIssues
// ---------------------------------------------------------------------------

const validEnvelope = JSON.stringify({
  data: [
    { id: "issue-1", title: "First Issue", status: "open" },
    { id: "issue-2", title: "Second Issue", status: "in_progress" },
  ],
});

const result1 = await getOpenIssues(undefined, async () => validEnvelope);
assert.strictEqual(result1.length, 2, "should parse two issues");
assert.strictEqual(result1[0]!.id, "issue-1", "first issue id should match");
assert.strictEqual(result1[0]!.title, "First Issue", "first issue title should match");
assert.strictEqual(result1[1]!.status, "in_progress", "second issue status should match");

// Returns empty array when JSON is invalid
const result2 = await getOpenIssues(undefined, async () => "not json");
assert.deepStrictEqual(result2, [], "invalid JSON should return empty array");

// Returns empty array when schema validation fails
const badSchema = JSON.stringify({
  data: [{ id: "issue-1", title: "Missing Status" }],
});
const result3 = await getOpenIssues(undefined, async () => badSchema);
assert.deepStrictEqual(result3, [], "schema violation should return empty array");

// Returns empty array when query throws
const result4 = await getOpenIssues(undefined, async () => {
  throw new Error("command failed");
});
assert.deepStrictEqual(result4, [], "thrown error should return empty array");

// ---------------------------------------------------------------------------
// waitForOpenIssues
// ---------------------------------------------------------------------------

// Returns immediately when issues are present
const result5 = await waitForOpenIssues(1, undefined, {
  query: async () => validEnvelope,
  sleep: async () => {},
});
assert.strictEqual(result5.length, 2, "waitForOpenIssues should return issues immediately");

// Polls until issues appear
let callCount = 0;
const result6 = await waitForOpenIssues(1, undefined, {
  query: async () => {
    callCount++;
    if (callCount < 3) {
      return JSON.stringify({ data: [] });
    }
    return validEnvelope;
  },
  sleep: async () => {},
});
assert.strictEqual(callCount, 3, "should poll three times");
assert.strictEqual(result6.length, 2, "should return issues after polling");

console.log("All issues helper tests passed!");
