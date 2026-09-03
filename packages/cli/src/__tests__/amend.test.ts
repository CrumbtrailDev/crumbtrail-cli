import { describe, expect, it } from "vitest";
import {
  AMENDABLE_CALLEES,
  FIELD_NAMES,
  amendSource,
  findCallSites,
  type AmendableCallee,
} from "../inject/amend";

const ENDPOINT = "https://ingest.example.com";

const fields = [
  { requirement: "endpoint" as const, value: JSON.stringify(ENDPOINT) },
  {
    requirement: "service-name" as const,
    value: (_callee: AmendableCallee, quote: (value: string) => string) =>
      quote("web"),
  },
];

describe("amendSource", () => {
  it("amends a clean init and preserves the existing source", () => {
    const source = [
      'import { Crumbtrail } from "crumbtrail-core";',
      "Crumbtrail.init({",
      "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,",
      "});",
    ].join("\n");

    const result = amendSource(source, fields);

    expect(result?.text).toContain(`httpEndpoint: "${ENDPOINT}",`);
    expect(result?.text).toContain('service: "web",');
    expect(result?.blocked).toEqual([]);
  });

  it("returns no text when one requested field is blocked", () => {
    const source = [
      "Crumbtrail.init({",
      '  httpEndpoint: "https://customer.example.com",',
      "});",
    ].join("\n");

    const result = amendSource(source, fields);

    expect(result?.text).toBeUndefined();
    expect(result?.blocked).toMatchObject([
      {
        requirement: "endpoint",
        existingKey: "httpEndpoint",
        reason: "already-set",
      },
    ]);
  });

  it("returns no text for a transport instance", () => {
    const result = amendSource(
      ["Crumbtrail.init({", "  transportInstance: transport,", "});"].join(
        "\n",
      ),
      [
        {
          requirement: "service-name",
          value: (_callee, quote) => quote("web"),
        },
      ],
    );

    expect(result?.text).toBeUndefined();
  });

  it("does not add service to an Express middleware option object", () => {
    const result = amendSource(
      "createCrumbtrailExpressMiddleware({ endpoint });",
      [
        {
          requirement: "service-name",
          value: (_callee, quote) => quote("api"),
        },
      ],
    );

    expect(result?.text).toBeUndefined();
    expect(result?.blocked).toEqual([
      { requirement: "service-name", reason: "unsupported-here" },
    ]);
  });
});

describe("amend exports", () => {
  it("keeps every supported call and SDK field mapping visible", () => {
    expect(AMENDABLE_CALLEES).toEqual([
      "Crumbtrail.init",
      "autoCapture",
      "createCrumbtrailExpressMiddleware",
      "createCrumbtrailExpressErrorMiddleware",
    ]);
    expect(FIELD_NAMES["Crumbtrail.init"]).toMatchObject({
      endpoint: "httpEndpoint",
      "ingest-key": "httpAuthToken",
      "service-name": "service",
      "remote-config": "remoteConfig",
    });
    expect(FIELD_NAMES.createCrumbtrailExpressMiddleware).not.toHaveProperty(
      "service-name",
    );
    expect(
      FIELD_NAMES.createCrumbtrailExpressErrorMiddleware,
    ).not.toHaveProperty("service-name");
  });

  it("finds namespaced middleware calls", () => {
    expect(
      findCallSites("node.createCrumbtrailExpressMiddleware({ endpoint });"),
    ).toHaveLength(1);
  });
});
