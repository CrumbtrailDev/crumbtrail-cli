import { describe, expect, it } from "vitest";
import { isCapturableContentTypeForTest } from "../express";

// The content-type gate decides what counts as evidence at all: a type it does
// not recognise is not redacted, it is dropped, and the bundle is left holding a
// status code. It is written as text-bearing families rather than exact types,
// so a JSON:API document, a problem+json error, an ndjson stream or a SOAP
// envelope is captured on the same footing as plain JSON without each needing
// its own entry. This table is the guard against that breadth quietly narrowing.
describe("capturable content types", () => {
  const CAPTURABLE = [
    "application/json",
    "application/json; charset=utf-8",
    "application/vnd.api+json",
    "application/ld+json",
    "application/problem+json",
    "application/x-ndjson",
    "application/xml",
    "application/soap+xml",
    "application/graphql",
    "application/csv",
    "application/yaml",
    "application/x-www-form-urlencoded",
    "text/plain",
    "text/html; charset=utf-8",
    "text/csv",
    "text/event-stream",
  ];

  const SKIPPED = [
    "image/png",
    "image/avif",
    "font/woff2",
    "application/zip",
    "application/octet-stream",
    "application/pdf",
    "video/mp4",
    "audio/mpeg",
  ];

  it("captures every text-bearing family", () => {
    for (const type of CAPTURABLE) {
      expect({
        type,
        capturable: isCapturableContentTypeForTest(type),
      }).toEqual({ type, capturable: true });
    }
  });

  it("skips binary payloads", () => {
    for (const type of SKIPPED) {
      expect({
        type,
        capturable: isCapturableContentTypeForTest(type),
      }).toEqual({ type, capturable: false });
    }
  });
});
