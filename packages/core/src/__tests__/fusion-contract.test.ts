import { describe, expect, it } from "vitest";
import { FUSION_SCHEMA_VERSION } from "../fusion";
import * as core from "../index";

describe("fusion contract", () => {
  it("pins the schema version", () => {
    expect(FUSION_SCHEMA_VERSION).toBe("fusion.v1");
  });
  it("is re-exported from the barrel", () => {
    expect(core.FUSION_SCHEMA_VERSION).toBe("fusion.v1");
  });
});
