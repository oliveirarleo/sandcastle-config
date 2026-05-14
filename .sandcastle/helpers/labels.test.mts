import { describe, it, expect } from "vitest";
import {
  LABEL_PLANNED,
  LABEL_EXECUTING,
  LABEL_REVIEWING,
  LABEL_EXECUTED,
  LABEL_MERGED,
  ALL_SANDCASTLE_LABELS,
  bdAddLabelCmd,
  bdRemoveLabelCmd,
  bdSetMetadataCmd,
  bdReadyByLabelCmd,
  bdListAllSandcastleCmd,
  parseLabeledEnvelope,
} from "./labels.mts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("sandcastle label constants", () => {
  it("defines five phase labels in transition order", () => {
    expect(ALL_SANDCASTLE_LABELS).toEqual([
      "sandcastle:planned",
      "sandcastle:executing",
      "sandcastle:reviewing",
      "sandcastle:executed",
      "sandcastle:merged",
    ]);
  });

  it("exports individual constants matching the array", () => {
    expect(LABEL_PLANNED).toBe("sandcastle:planned");
    expect(LABEL_EXECUTING).toBe("sandcastle:executing");
    expect(LABEL_REVIEWING).toBe("sandcastle:reviewing");
    expect(LABEL_EXECUTED).toBe("sandcastle:executed");
    expect(LABEL_MERGED).toBe("sandcastle:merged");
  });
});

// ---------------------------------------------------------------------------
// bd command builders
// ---------------------------------------------------------------------------

describe("bdAddLabelCmd", () => {
  it("produces a bd update --add-label command", () => {
    expect(bdAddLabelCmd("sandcastle-3zc", "sandcastle:planned")).toBe(
      "bd update sandcastle-3zc --add-label sandcastle:planned",
    );
  });
});

describe("bdRemoveLabelCmd", () => {
  it("produces a bd update --remove-label command", () => {
    expect(bdRemoveLabelCmd("issue-1", "sandcastle:executing")).toBe(
      "bd update issue-1 --remove-label sandcastle:executing",
    );
  });
});

describe("bdSetMetadataCmd", () => {
  it("produces a bd update --set-metadata command", () => {
    expect(
      bdSetMetadataCmd("issue-1", "sandcastle.implement_session", "sess-abc"),
    ).toBe(
      "bd update issue-1 --set-metadata sandcastle.implement_session=sess-abc",
    );
  });
});

describe("bdReadyByLabelCmd", () => {
  it("queries open issues with a specific label", () => {
    expect(bdReadyByLabelCmd("sandcastle:executing")).toBe(
      "BD_JSON_ENVELOPE=1 bd ready --json --label 'sandcastle:executing'",
    );
  });
});

describe("bdListAllSandcastleCmd", () => {
  it("queries all issues (including closed) with any sandcastle label", () => {
    const cmd = bdListAllSandcastleCmd();
    expect(cmd).toContain("bd list --json --all");
    for (const label of ALL_SANDCASTLE_LABELS) {
      expect(cmd).toContain(`--label-any '${label}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// parseLabeledEnvelope
// ---------------------------------------------------------------------------

describe("parseLabeledEnvelope", () => {
  const envelopeWithLabels = JSON.stringify({
    data: [
      {
        id: "issue-1",
        title: "Fix A",
        status: "open",
        labels: ["ready-for-agent", "sandcastle:planned"],
      },
      {
        id: "issue-2",
        title: "Fix B",
        status: "open",
        labels: ["sandcastle:executing"],
      },
    ],
    schema_version: 1,
  });

  it("parses a valid BD_JSON_ENVELOPE with labels", () => {
    const issues = parseLabeledEnvelope(envelopeWithLabels);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.id).toBe("issue-1");
    expect(issues[0]!.labels).toEqual([
      "ready-for-agent",
      "sandcastle:planned",
    ]);
    expect(issues[1]!.id).toBe("issue-2");
    expect(issues[1]!.labels).toEqual(["sandcastle:executing"]);
  });

  it("defaults labels to empty array when missing", () => {
    const noLabels = JSON.stringify({
      data: [{ id: "issue-3", title: "Fix C", status: "open" }],
      schema_version: 1,
    });
    const issues = parseLabeledEnvelope(noLabels);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toEqual([]);
  });

  it("returns empty array on invalid JSON", () => {
    expect(parseLabeledEnvelope("not json")).toEqual([]);
  });

  it("returns empty array when data field is missing", () => {
    expect(
      parseLabeledEnvelope(JSON.stringify({ stuff: [] })),
    ).toEqual([]);
  });

  it("returns empty array when data items are malformed", () => {
    const badItems = JSON.stringify({
      data: [{ id: 123 }],
      schema_version: 1,
    });
    expect(parseLabeledEnvelope(badItems)).toEqual([]);
  });
});
