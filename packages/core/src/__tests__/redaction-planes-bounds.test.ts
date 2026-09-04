import { describe, expect, it } from "vitest";
import {
  BACKEND_REDACTION_POLICY,
  BROWSER_REDACTION_POLICY,
  BROWSER_REDACTION_POLICY_V2,
  OMITTED_DEPTH_VALUE,
  STRUCTURED_BODY_MAX_ARRAY_ENTRIES,
  STRUCTURED_BODY_MAX_DEPTH,
  STRUCTURED_BODY_MAX_KEY_LENGTH,
  STRUCTURED_BODY_MAX_OBJECT_KEYS,
  classifyStructuredValue,
  mergeRedactionMetadata,
  redactNetworkTextBody,
  summarizeOmittedPayload,
  withRedactionPolicy,
  type RedactionField,
  type RedactionMetadata,
} from "../index";

function structured(body: string) {
  return redactNetworkTextBody(body, {
    contentType: "application/json",
    mode: "structured",
    path: "body",
  });
}

function fieldsByReason(
  fields: RedactionField[] | undefined,
  reason: string,
): RedactionField[] {
  return (fields ?? []).filter((field) => field.reason === reason);
}

describe("backend redaction plane (D1)", () => {
  it("exposes the backend policy id the capture server matches on", () => {
    expect(BACKEND_REDACTION_POLICY).toBe("crumbtrail.backend-redaction.v1");
  });

  it("restamps already-produced metadata with the calling plane", () => {
    const browser = structured(JSON.stringify({ token: "sk_live_abcdef123456" }))
      .metadata;
    expect(browser?.policy).toBe(BROWSER_REDACTION_POLICY_V2);

    const backend = withRedactionPolicy(browser, BACKEND_REDACTION_POLICY);
    expect(backend?.policy).toBe(BACKEND_REDACTION_POLICY);
    // The fields are the same evidence; only the producer claim changed.
    expect(backend?.fields).toEqual(browser?.fields);
    expect(browser?.policy).toBe(BROWSER_REDACTION_POLICY_V2);
  });

  it("returns the same object when the policy already matches", () => {
    const metadata: RedactionMetadata = {
      policy: BACKEND_REDACTION_POLICY,
      fields: [],
    };
    expect(withRedactionPolicy(metadata, BACKEND_REDACTION_POLICY)).toBe(
      metadata,
    );
    expect(withRedactionPolicy(undefined, BACKEND_REDACTION_POLICY)).toBe(
      undefined,
    );
  });

  it("lets the plane win over the browser version when metadata merges", () => {
    const merged = mergeRedactionMetadata(
      { policy: BROWSER_REDACTION_POLICY_V2, fields: [] },
      {
        policy: BACKEND_REDACTION_POLICY,
        fields: [{ path: "body", reason: "deny_field", action: "redacted" }],
      },
    );
    expect(merged?.policy).toBe(BACKEND_REDACTION_POLICY);

    const browserOnly = mergeRedactionMetadata(
      { policy: BROWSER_REDACTION_POLICY, fields: [] },
      {
        policy: BROWSER_REDACTION_POLICY_V2,
        fields: [{ path: "body", reason: "deny_field", action: "redacted" }],
      },
    );
    expect(browserOnly?.policy).toBe(BROWSER_REDACTION_POLICY_V2);
  });
});

describe("structured walker bounds (D2)", () => {
  it("replaces only the subtree past the depth bound and keeps its siblings", () => {
    let deep: unknown = { bottom: "reached" };
    for (let level = 0; level < STRUCTURED_BODY_MAX_DEPTH + 10; level += 1)
      deep = { next: deep };

    const result = structured(
      JSON.stringify({ orderId: "ord_42", total: 1999, nested: deep }),
    );
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;

    // Every operand outside the offending subtree survives.
    expect(parsed.orderId).toBe("ord_42");
    expect(parsed.total).toBe(1999);
    expect(JSON.stringify(parsed)).toContain(OMITTED_DEPTH_VALUE);

    const depthFields = fieldsByReason(
      result.metadata?.fields,
      "structure_depth_exceeded",
    );
    expect(depthFields).toHaveLength(1);
    expect(depthFields[0]).toMatchObject({
      action: "summarized",
      limit: STRUCTURED_BODY_MAX_DEPTH,
      observed: STRUCTURED_BODY_MAX_DEPTH,
    });
  });

  it("survives a hostile nesting depth instead of dropping the whole body", () => {
    const depth = 20_000;
    const body = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const result = structured(body);

    expect(result.body).toBeDefined();
    expect(result.bodySummary?.action).not.toBe("dropped");
    expect(
      fieldsByReason(result.metadata?.fields, "structure_depth_exceeded"),
    ).toHaveLength(1);
  });

  it("shortens an over-long array and says how long it was", () => {
    const rows = Array.from(
      { length: STRUCTURED_BODY_MAX_ARRAY_ENTRIES + 25 },
      (_unused, index) => ({ id: index }),
    );
    const result = structured(JSON.stringify({ rows }));
    const parsed = JSON.parse(result.body as string) as {
      rows: Array<{ id: number }>;
    };

    expect(parsed.rows).toHaveLength(STRUCTURED_BODY_MAX_ARRAY_ENTRIES);
    expect(parsed.rows[0]).toEqual({ id: 0 });
    expect(fieldsByReason(result.metadata?.fields, "array_length_exceeded")[0])
      .toMatchObject({
        path: "body.rows",
        action: "summarized",
        limit: STRUCTURED_BODY_MAX_ARRAY_ENTRIES,
        observed: rows.length,
      });
  });

  it("keeps an ordinary result table whole", () => {
    // The reported regression: a 41 row page came back empty. It must not.
    const rows = Array.from({ length: 41 }, (_unused, index) => ({
      id: index,
      quantity: index * 2,
    }));
    const result = structured(JSON.stringify({ rows }));
    const parsed = JSON.parse(result.body as string) as { rows: unknown[] };

    expect(parsed.rows).toHaveLength(41);
    expect(parsed.rows[40]).toEqual({ id: 40, quantity: 80 });
    expect(result.metadata?.fields ?? []).toEqual([]);
  });

  it("caps object key count and keeps the kept keys intact", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < STRUCTURED_BODY_MAX_OBJECT_KEYS + 40; index += 1)
      wide[`flag_${index}`] = index;

    const result = structured(JSON.stringify(wide));
    const parsed = JSON.parse(result.body as string) as Record<string, number>;

    expect(Object.keys(parsed)).toHaveLength(STRUCTURED_BODY_MAX_OBJECT_KEYS);
    expect(parsed.flag_0).toBe(0);
    expect(fieldsByReason(result.metadata?.fields, "object_keys_exceeded")[0])
      .toMatchObject({
        path: "body",
        action: "summarized",
        limit: STRUCTURED_BODY_MAX_OBJECT_KEYS,
        observed: STRUCTURED_BODY_MAX_OBJECT_KEYS + 40,
      });
  });

  it("bounds an absurdly long key without losing its value", () => {
    // Deliberately not token-like. `sanitizeKeyName` replaces a key that reads
    // as a credential, and a long unbroken run of word characters trips that on
    // its own. A key made of spaced words does not, at any length, so before
    // this bound a kilobyte of key name passed straight through and into every
    // field path built from it.
    const longKey = "metric label ".repeat(60);
    const result = structured(JSON.stringify({ [longKey]: "kept", ok: 1 }));
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;

    const emitted = Object.keys(parsed).find((key) => key !== "ok");
    expect(emitted).toBeDefined();
    expect((emitted as string).length).toBe(STRUCTURED_BODY_MAX_KEY_LENGTH + 1);
    expect(parsed[emitted as string]).toBe("kept");
    expect(parsed.ok).toBe(1);
    expect(fieldsByReason(result.metadata?.fields, "json_key_too_long")[0])
      .toMatchObject({
        action: "summarized",
        limit: STRUCTURED_BODY_MAX_KEY_LENGTH,
        observed: longKey.length,
      });
  });
});

describe("clean and absent captures (D3)", () => {
  it("reports a structured body that needed nothing removed as inspected", () => {
    const body = JSON.stringify({ status: "ok", count: 3 });
    const result = structured(body);

    expect(result.body).toBe(body);
    expect(result.bodySummary).toEqual({
      kind: "json",
      action: "inspected",
      reason: "no_sensitive_fields",
      originalLength: body.length,
      redactedFields: 0,
    });
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY_V2);
    expect(result.metadata?.fields).toEqual([]);
  });

  it("reports a clean v1 JSON body as inspected rather than as silence", () => {
    const body = JSON.stringify({ couponCode: "EXPIRED5" });
    const result = redactNetworkTextBody(body, {
      contentType: "application/json",
      path: "body",
    });

    expect(result.body).toBe(body);
    expect(result.bodySummary?.action).toBe("inspected");
    expect(result.bodySummary?.reason).toBe("no_sensitive_fields");
    expect(result.metadata?.policy).toBe(BROWSER_REDACTION_POLICY);
    expect(result.metadata?.fields).toEqual([]);
  });

  it("still reports a redacted body as redacted", () => {
    const result = structured(
      JSON.stringify({ password: "hunter2!", status: "ok" }),
    );
    expect(result.bodySummary?.action).toBe("redacted");
    expect(result.bodySummary?.reason).toBe("structured_redaction");
  });

  it("separates an absent body from one that was dropped", () => {
    const absent = summarizeOmittedPayload("no_body");
    expect(absent.body).toBeUndefined();
    expect(absent.bodySummary).toMatchObject({
      kind: "unknown",
      action: "absent",
      reason: "no_body",
    });
    expect(absent.metadata?.fields[0]).toMatchObject({
      path: "body",
      reason: "no_body",
      action: "absent",
    });

    const dropped = summarizeOmittedPayload("body_read_failed");
    expect(dropped.bodySummary?.action).toBe("dropped");
  });
});

describe("the omitted-depth marker survives a second pass", () => {
  function deeplyNested(levels: number): string {
    let value: unknown = { leaf: 1 };
    for (let index = 0; index < levels; index += 1) value = { n: value };
    return JSON.stringify(value);
  }

  it("classifies the marker as an engine marker rather than free text", () => {
    expect(classifyStructuredValue(OMITTED_DEPTH_VALUE)).toEqual({
      action: "keep",
    });
  });

  it("still redacts the marker when the field name is denied", () => {
    const result = structured(JSON.stringify({ ssn: OMITTED_DEPTH_VALUE }));
    expect(result.body).not.toContain(OMITTED_DEPTH_VALUE);
  });

  it("does not invent a value shape for a subtree that was never read", () => {
    const first = structured(deeplyNested(STRUCTURED_BODY_MAX_DEPTH + 6));
    expect(first.body).toContain(OMITTED_DEPTH_VALUE);

    const second = structured(first.body as string);
    expect(second.body).toContain(OMITTED_DEPTH_VALUE);
    // The fabricated shape the cloud had to work around: a $redacted wrapper
    // describing the marker's own characters as if they were a captured value.
    expect(second.body).not.toContain("$redacted");
    expect(fieldsByReason(second.metadata?.fields, "free_text_value")).toEqual(
      [],
    );
  });
});
