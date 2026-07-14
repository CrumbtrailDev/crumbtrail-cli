import { describe, expect, it } from "vitest";
import { EVIDENCE_SCHEMA_VERSION } from "../evidence";
import * as core from "../index";

describe("evidence contract", () => {
  it("pins the schema version", () => {
    expect(EVIDENCE_SCHEMA_VERSION).toBe("evidence.v1");
  });

  it("is re-exported from the package barrel", () => {
    expect(core.EVIDENCE_SCHEMA_VERSION).toBe("evidence.v1");
  });
});
