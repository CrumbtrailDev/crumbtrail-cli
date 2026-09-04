import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BoundedBodyRecorder } from "../bounded-body-recorder";
import {
  attachRequestBodyRecorder,
  readRequestBodyEvidence,
  type RequestBodyEvidence,
} from "../backend-request-body";
import {
  attachResponseRecorder,
  readResponseEvidence,
  type BackendResponseCaptureOptions,
  type ResponseEvidence,
} from "../backend-response";

async function captureHttp(
  frames: Buffer[],
  cap: number,
  contentType = "text/plain",
  responseOptions: BackendResponseCaptureOptions = {},
  captureRequestBody: "all" | "off" = "all",
) {
  let requestEvidence: RequestBodyEvidence = {};
  let responseEvidence: ResponseEvidence = {};
  const received: Buffer[] = [];
  const server = createServer((req, res) => {
    const reqOptions = { captureRequestBody, requestBodyMaxBytes: cap };
    const resOptions: BackendResponseCaptureOptions = {
      captureResponseBody: "all",
      responseBodyMaxBytes: cap,
      ...responseOptions,
    };
    const reqRecorder = attachRequestBodyRecorder(req, reqOptions);
    const resRecorder = attachResponseRecorder(res, resOptions);
    req.on("data", (chunk: Buffer) => received.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", contentType);
      for (const frame of frames) res.write(frame);
      res.end();
      requestEvidence = readRequestBodyEvidence(
        req,
        res,
        reqRecorder,
        reqOptions,
      );
      responseEvidence = readResponseEvidence(res, resRecorder, resOptions);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          method: "POST",
          headers: { "content-type": contentType },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      for (const frame of frames) req.write(frame);
      req.end();
    });
    expect(Buffer.concat(received)).toEqual(Buffer.concat(frames));
    expect(result).toEqual(Buffer.concat(frames));
    return { requestEvidence, responseEvidence };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("bounded backend body evidence", () => {
  it("marks data arriving after an exact cap as truncated on both HTTP directions", async () => {
    const { requestEvidence, responseEvidence } = await captureHttp(
      [Buffer.from("abcd"), Buffer.from("more")],
      4,
    );
    expect(requestEvidence).toEqual({
      requestBody: "abcd",
      requestBodyTruncated: true,
    });
    expect(responseEvidence).toMatchObject({
      responseBody: "abcd",
      responseBodyTruncated: true,
    });
  });
  it("reassembles Unicode split across HTTP chunks without corrupting application bytes", async () => {
    const payload = Buffer.from("A😀é界Z");
    const frames = Array.from(payload, (byte) => Buffer.from([byte]));
    const { requestEvidence, responseEvidence } = await captureHttp(
      frames,
      payload.length,
    );
    expect(requestEvidence).toEqual({ requestBody: payload.toString() });
    expect(responseEvidence.responseBody).toBe(payload.toString());
    expect(responseEvidence.responseBodyTruncated).toBeUndefined();
  });
  it("omits a code point cut by the cap and obeys UTF8 byte bounds", async () => {
    const { requestEvidence, responseEvidence } = await captureHttp(
      [Buffer.from("A😀é界Z")],
      6,
    );
    expect(requestEvidence).toEqual({
      requestBody: "A😀",
      requestBodyTruncated: true,
    });
    expect(responseEvidence).toMatchObject({
      responseBody: "A😀",
      responseBodyTruncated: true,
    });
    expect(
      Buffer.byteLength(responseEvidence.responseBody!),
    ).toBeLessThanOrEqual(6);
  });
  it("gates binary bodies even when response headers are disabled", async () => {
    const { requestEvidence, responseEvidence } = await captureHttp(
      [Buffer.from([0xff, 0, 0xff])],
      16,
      "image/png",
      { responseHeaderAllowlist: [] },
    );
    expect(requestEvidence).toEqual({});
    expect(responseEvidence).toEqual({});
  });
  it("retains textual bodies with header capture disabled", async () => {
    const { responseEvidence } = await captureHttp(
      [Buffer.from("details")],
      16,
      "text/plain",
      { responseHeaderAllowlist: [] },
    );
    expect(responseEvidence).toEqual({ responseBody: "details" });
  });
  it("honors disabled body capture in both directions", async () => {
    const { requestEvidence, responseEvidence } = await captureHttp(
      [Buffer.from("private")],
      16,
      "text/plain",
      { captureResponseBody: "off" },
      "off",
    );
    expect(requestEvidence).toEqual({});
    expect(responseEvidence).toEqual({});
  });
  it("bounds the parsed request body fallback by UTF8 bytes", () => {
    const req = { body: "A😀é界Z" };
    const options = {
      captureRequestBody: "all" as const,
      requestBodyMaxBytes: 6,
    };
    expect(
      readRequestBodyEvidence(
        req,
        { statusCode: 200 },
        attachRequestBodyRecorder(req, options),
        options,
      ),
    ).toEqual({ requestBody: "A😀", requestBodyTruncated: true });
  });
  it("keeps chunk boundaries out of decoding and detects later overflow", () => {
    const recorder = new BoundedBodyRecorder(4);
    for (const byte of Buffer.from("😀")) recorder.record(Buffer.from([byte]));
    expect(recorder.read()).toBe("😀");
    expect(recorder.truncated).toBe(false);
    recorder.record(Buffer.alloc(0));
    expect(recorder.truncated).toBe(false);
    recorder.record("x");
    expect(recorder.truncated).toBe(true);
    expect(recorder.read()).toBe("😀");
  });
  it("captures encoded strings as the bytes the response actually sends", () => {
    const recorder = new BoundedBodyRecorder(16);
    recorder.record("c3a9", "hex");
    recorder.record("8J+YgA==", "base64");
    expect(recorder.read()).toBe("é😀");
    expect(recorder.bytes).toBe(6);
  });
  it("copies retained bytes before the application reuses its buffer", () => {
    const recorder = new BoundedBodyRecorder(4);
    const buffer = Buffer.from("data");
    recorder.record(buffer);
    buffer.fill(0);
    expect(recorder.read()).toBe("data");
  });
  it("bounds replacement characters produced by malformed UTF8", () => {
    const recorder = new BoundedBodyRecorder(4);
    recorder.record(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(Buffer.byteLength(recorder.read())).toBeLessThanOrEqual(4);
    expect(recorder.truncated).toBe(true);
  });
  it("marks an unfinished final UTF8 sequence without emitting a replacement", () => {
    const recorder = new BoundedBodyRecorder(8);
    recorder.record(Buffer.from([0x41, 0xf0, 0x9f]));
    expect(recorder.read()).toBe("A");
    expect(recorder.truncated).toBe(true);
  });
  it("reports truncation when the cap cannot hold the first parsed code point", () => {
    const req = { body: "😀" };
    const options = {
      captureRequestBody: "all" as const,
      requestBodyMaxBytes: 1,
    };
    expect(
      readRequestBodyEvidence(
        req,
        { statusCode: 200 },
        attachRequestBodyRecorder(req, options),
        options,
      ),
    ).toEqual({ requestBodyTruncated: true });
  });
});
