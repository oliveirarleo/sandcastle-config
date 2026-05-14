import { describe, expect, it } from "vitest";
import { type BeadsIssue, BeadsIssueSchema, PlannerOutputSchema } from "./types.mts";

describe("BeadsIssueSchema", () => {
	it("parses a valid issue", () => {
		const validIssue = { id: "test-1", title: "Test Issue", status: "open" };
		const parsedIssue = BeadsIssueSchema.parse(validIssue);
		expect(parsedIssue.id).toBe("test-1");
		expect(parsedIssue.title).toBe("Test Issue");
		expect(parsedIssue.status).toBe("open");
	});

	it("throws when status is missing", () => {
		expect(() => BeadsIssueSchema.parse({ id: "test-1", title: "Test Issue" })).toThrow();
	});

	it("throws when title is missing", () => {
		expect(() => BeadsIssueSchema.parse({ id: "test-1", status: "open" })).toThrow();
	});
});

describe("PlannerOutputSchema", () => {
	it("parses a valid plan", () => {
		const validPlan = {
			issues: [{ id: "i1", title: "Issue 1", branch: "branch-1" }],
		};
		const parsedPlan = PlannerOutputSchema.parse(validPlan);
		expect(parsedPlan.issues).toHaveLength(1);
		expect(parsedPlan.issues[0]?.id).toBe("i1");
	});

	it("throws when branch is missing", () => {
		expect(() => PlannerOutputSchema.parse({ issues: [{ id: "i1", title: "Issue 1" }] })).toThrow();
	});
});

describe("BeadsIssue type", () => {
	it("allows creating a valid typed issue", () => {
		const issue: BeadsIssue = {
			id: "type-test",
			title: "Type Test",
			status: "open",
			labels: [],
		};
		expect(issue.id).toBe("type-test");
	});
});

describe("BeadsIssue labels", () => {
	it("defaults to empty array when labels field is missing", () => {
		const parsed = BeadsIssueSchema.parse({ id: "test", title: "T", status: "open" });
		expect(parsed.labels).toEqual([]);
	});

	it("preserves labels when present", () => {
		const parsed = BeadsIssueSchema.parse({
			id: "test",
			title: "T",
			status: "open",
			labels: ["sandcastle:planned"],
		});
		expect(parsed.labels).toEqual(["sandcastle:planned"]);
	});
});
