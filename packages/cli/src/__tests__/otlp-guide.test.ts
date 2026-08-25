// The guide file is the only thing a non-JS service gets from a run, and it is
// still there tomorrow when the reader comes back to it. It used to open with
// "This service is already provisioned in Crumbtrail and has its own ingest
// key", and close by calling the value in the snippet a live credential. Only
// the provisioning half was ever true: planOtlp fills the snippet with a
// placeholder on purpose and no key is minted anywhere on that path, so the
// reader could not configure the exporter and went looking for a secret that
// did not exist.

import { describe, expect, it } from "vitest";
import { renderOtlpGuide } from "../otlp-guide";

const INPUT = {
  stack: "fastapi" as const,
  serviceName: "payments",
  endpoint: "https://cloud.example",
  snippet:
    "OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.example\nOTEL_EXPORTER_OTLP_HEADERS=X-Crumbtrail-Auth=<your-ingest-key>",
  agentPrompt: "Point the exporter at Crumbtrail",
};

describe("renderOtlpGuide", () => {
  it("never claims a key exists that was never minted", () => {
    const body = renderOtlpGuide(INPUT);
    expect(body).not.toMatch(/has its own ingest key/i);
    expect(body).toMatch(/No ingest key was minted/i);
  });

  it("names the placeholder and where the real key is minted", () => {
    const body = renderOtlpGuide({
      ...INPUT,
      mintUrl: "https://app.example/p/prj_1/setup",
    });
    expect(body).toContain("<your-ingest-key>");
    expect(body).toContain("Mint one at https://app.example/p/prj_1/setup");
  });

  it("still points somewhere when no project scoped URL was supplied", () => {
    const body = renderOtlpGuide(INPUT);
    expect(body).toMatch(/Setup page of your Crumbtrail dashboard/);
  });

  it("makes the credential warning conditional on a real key being pasted in", () => {
    const body = renderOtlpGuide(INPUT);
    expect(body).toMatch(
      /Once you replace <your-ingest-key> with a real key, this file holds a live/,
    );
  });

  it("keeps the parts a reader needs: stack, endpoint, snippet, agent prompt", () => {
    const body = renderOtlpGuide(INPUT);
    expect(body).toContain("**fastapi**");
    expect(body).toContain("Ingest endpoint: https://cloud.example");
    expect(body).toContain(INPUT.snippet);
    expect(body).toContain(INPUT.agentPrompt);
  });
});
