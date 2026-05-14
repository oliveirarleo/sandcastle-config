import assert from "assert";
import { BeadsIssueSchema, PlannerOutputSchema, type BeadsIssue } from "./types.mts";

// Test BeadsIssueSchema with valid data
const validIssue = { id: "test-1", title: "Test Issue", status: "open" };
const parsedIssue = BeadsIssueSchema.parse(validIssue);
assert.strictEqual(parsedIssue.id, "test-1", "parsed issue id should match");
assert.strictEqual(parsedIssue.title, "Test Issue", "parsed issue title should match");
assert.strictEqual(parsedIssue.status, "open", "parsed issue status should match");

// Test BeadsIssueSchema throws with invalid data
assert.throws(() => BeadsIssueSchema.parse({ id: "test-1", title: "Test Issue" }), "missing status should throw");
assert.throws(() => BeadsIssueSchema.parse({ id: "test-1", status: "open" }), "missing title should throw");

// Test PlannerOutputSchema with valid data
const validPlan = { issues: [{ id: "i1", title: "Issue 1", branch: "branch-1" }] };
const parsedPlan = PlannerOutputSchema.parse(validPlan);
assert.strictEqual(parsedPlan.issues.length, 1, "parsed plan should have 1 issue");
assert.strictEqual(parsedPlan.issues[0]!.id, "i1", "parsed plan issue id should match");

// Test PlannerOutputSchema throws with invalid data
assert.throws(() => PlannerOutputSchema.parse({ issues: [{ id: "i1", title: "Issue 1" }] }), "missing branch should throw");

// Test BeadsIssue type
const issue: BeadsIssue = { id: "type-test", title: "Type Test", status: "open" };
assert.strictEqual(issue.id, "type-test", "typed issue id should match");

console.log("All types tests passed!");
