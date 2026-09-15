import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeDecisionState } from "./progress-model.ts";

describe("mergeDecisionState", () => {
  it("keeps independent decisions from competing tabs", () => {
    const merged = mergeDecisionState(
      {
        decisions: { "5900000000001": "import" },
        decisionMeta: { "5900000000001": { updatedAt: 10, writer: "tab-a" } },
      },
      {
        decisions: { "5900000000002": "reject" },
        decisionMeta: { "5900000000002": { updatedAt: 11, writer: "tab-b" } },
      },
    );
    assert.deepEqual(merged.decisions, {
      "5900000000001": "import",
      "5900000000002": "reject",
    });
  });

  it("does not let an older whole snapshot undo a newer mark", () => {
    const merged = mergeDecisionState(
      {
        decisions: { "5900000000001": "reject" },
        decisionMeta: { "5900000000001": { updatedAt: 20, writer: "new-tab" } },
      },
      {
        decisions: { "5900000000001": "import" },
        decisionMeta: { "5900000000001": { updatedAt: 10, writer: "stale-tab" } },
      },
    );
    assert.equal(merged.decisions["5900000000001"], "reject");
  });

  it("uses a deterministic writer tie-break for same-millisecond edits", () => {
    const merged = mergeDecisionState(
      {
        decisions: { "5900000000001": "import" },
        decisionMeta: { "5900000000001": { updatedAt: 20, writer: "tab-a" } },
      },
      {
        decisions: { "5900000000001": "reject" },
        decisionMeta: { "5900000000001": { updatedAt: 20, writer: "tab-z" } },
      },
    );
    assert.equal(merged.decisions["5900000000001"], "reject");
  });
});
