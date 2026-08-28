import { describe, expect, it } from "vitest";
import {
  OTLP_CAPABILITY_FACTS,
  buildOtlpSnippets,
  otlpBearerHeaderValue,
} from "../index";

// The wizard guidance (buildOtlpSnippets, driven by OTLP_CAPABILITY_FACTS) is
// the anti-drift gate for the receiver contract: compression none, no path
// suffix on the Crumbtrail endpoint, and the auth header names. The collector
// recipes this used to cross-check left the repository with
// packages/node/src/provider-recipes.json when crumbtrail-node became backend
// capture only.

const keys = { endpoint: "https://app.crumbtrail.com", apiKey: "bl_live_xyz" };

describe("OTLP capability facts", () => {
  it("buildOtlpSnippets reflects every capability fact", () => {
    const snippets = buildOtlpSnippets(keys);

    // Protocols: both http/protobuf and http/json.
    for (const protocol of OTLP_CAPABILITY_FACTS.protocols) {
      expect(snippets.env).toContain(protocol);
    }
    // Compression: recommended "none", surfaced as an env var.
    expect(snippets.env).toContain(
      `OTEL_EXPORTER_OTLP_COMPRESSION=${OTLP_CAPABILITY_FACTS.compression.recommended}`,
    );
    expect(OTLP_CAPABILITY_FACTS.compression.recommended).toBe("none");
    expect(OTLP_CAPABILITY_FACTS.compression.accepted).toContain("gzip");

    // Auth header names: X-Crumbtrail-Auth + Bearer, with the %20-escaped space.
    expect(snippets.authHeader).toContain("X-Crumbtrail-Auth=");
    expect(snippets.authHeader).toContain(otlpBearerHeaderValue(keys.apiKey));
    expect(snippets.authHeader).toContain("Bearer%20");
    // The previously-wrong unescaped space must NOT appear.
    expect(snippets.authHeader).not.toContain(`Bearer ${keys.apiKey}`);

    // Session attribute + appended paths.
    expect(snippets.sessionAttr).toContain(
      OTLP_CAPABILITY_FACTS.sessionAttribute,
    );
    for (const p of OTLP_CAPABILITY_FACTS.paths) {
      expect(snippets.note).toContain(p);
    }
    // The endpoint env var must NOT include a signal path suffix.
    expect(snippets.env).toContain(
      `OTEL_EXPORTER_OTLP_ENDPOINT=${keys.endpoint}`,
    );
    for (const p of OTLP_CAPABILITY_FACTS.paths) {
      expect(snippets.env).not.toContain(`${keys.endpoint}${p}`);
    }
  });
});
