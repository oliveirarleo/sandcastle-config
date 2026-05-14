import assert from "assert";
import { BeadsIssueSchema, PlannerOutputSchema, type BeadsIssue } from "./types.mts";

const validIssue = { id: "test-1", title: "Test Issue", status: "open" };
const parsedIssue = BeadsIssueSchema.parse(validIssue);
assert.strictEqual(parsedIssue.id, "test-1", "parsed issue id should match");
assert.strictEqual(parsedIssue.title, "Test Issue", "parsed issue title should match");
assert.strictEqual(parsedIssue.status, "open", "parsed issue status should match");

assert.throws(() => BeadsIssueSchema.parse({ id: "test-1", title: "Test Issue" }), "missing status should throw");
assert.throws(() => BeadsIssueSchema.parse({ id: "test-1", status: "open" }), "missing title should throw");

const validPlan = { issues: [{ id: "i1", title: "Issue 1", branch: "branch-1" }] };
const parsedPlan = PlannerOutputSchema.parse(validPlan);
assert.strictEqual(parsedPlan.issues.length, 1, "parsed plan should have 1 issue");

const firstIssue = parsedPlan.issues[0];
assert.ok(firstIssue, "parsed plan should have at least one issue");
assert.strictEqual(firstIssue.id, "i1", "parsed plan issue id should match");

assert.throws(() => PlannerOutputSchema.parse({ issues: [{ id: "i1", title: "Issue 1" }] }), "missing branch should throw");

const issue: BeadsIssue = { id: "type-test", title: "Type Test", status: "open" };
assert.strictEqual(issue.id, "type-test", "typed issue id should match");

console.log("All types tests passed!");
