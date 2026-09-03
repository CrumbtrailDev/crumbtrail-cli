import { describe, expect, it, vi } from "vitest";
import {
  extractBullMqContext,
  injectBullMqContext,
  stripBullMqContext,
  withCrumbtrailBullMqProcessor,
  withCrumbtrailBullMqProducer,
  type BullMqJobLike,
} from "../bullmq";
import type { CrumbtrailContextToken } from "../../distributed-context";

const TRACEPARENT =
  "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

function token(now = Date.now()): CrumbtrailContextToken {
  return {
    v: 1,
    sessionId: "session_parent",
    requestId: "request_parent",
    traceparent: TRACEPARENT,
    enqueuedAt: now - 1,
    expiresAt: now + 60_000,
  };
}

describe("BullMQ adapters", () => {
  it("injects a bounded token into a cloned data object and strips it", () => {
    const data = { orderId: "order_1", nested: { amount: 12 } };
    const carried = injectBullMqContext(data, token());

    expect(carried).not.toBe(data);
    expect(carried).toMatchObject({
      orderId: "order_1",
      __crumbtrail: { v: 1, sessionId: "session_parent" },
    });
    expect(data).toEqual({ orderId: "order_1", nested: { amount: 12 } });
    expect(extractBullMqContext(carried)).toMatchObject({
      sessionId: "session_parent",
    });
    expect(stripBullMqContext(carried)).toEqual(data);
  });

  it("fails closed for malformed carriers and preserves primitive payloads", () => {
    expect(
      extractBullMqContext({
        __crumbtrail: { v: 1, traceparent: "00-invalid" },
      }),
    ).toBeUndefined();
    expect(injectBullMqContext("payload", token())).toBe("payload");
  });

  it("uses the supplied clock consistently while injecting a token", () => {
    const carried = injectBullMqContext(
      { value: 1 },
      token(1_000),
      1_000,
    );

    expect(extractBullMqContext(carried, 1_000)).toMatchObject({
      sessionId: "session_parent",
    });
  });

  it("reports an invalid explicit token without changing the queue payload", () => {
    const losses: string[] = [];
    const queue = {
      add(_name: string, data: unknown) {
        return data;
      },
    };
    const wrapped = withCrumbtrailBullMqProducer(queue, {
      context: { v: 1, traceparent: "00-invalid" } as CrumbtrailContextToken,
      onCaptureLoss: (_error, phase) => losses.push(phase),
    });
    expect(wrapped.add?.("job", { value: 1 })).toEqual({ value: 1 });
    expect(losses).toEqual(["context"]);
  });

  it("does not overwrite reserved user fields and reports the capture loss", () => {
    const losses: Array<{ phase: string; message: string }> = [];
    const data = { __crumbtrail: "application-value", count: 2 };
    const carried = injectBullMqContext(data, token(), Date.now, (error, phase) => {
      losses.push({ phase, message: String(error) });
    });
    expect(carried).toEqual(data);
    expect(losses).toMatchObject([{ phase: "collision" }]);

    const payloadField = { __crumbtrailPayload: "application-value" };
    const second = injectBullMqContext(
      payloadField,
      token(),
      Date.now,
      (_error, phase) => losses.push({ phase, message: "payload collision" }),
    );
    expect(second).toEqual(payloadField);
    expect(losses).toMatchObject([{ phase: "collision" }, { phase: "collision" }]);

    const userCarrier = { __crumbtrail: token(), value: "application" };
    expect(stripBullMqContext(userCarrier)).toEqual(userCarrier);
  });

  it("wraps add and addBulk without changing queue identity or options", async () => {
    const added: unknown[] = [];
    const queue = {
      name: "payments",
      add(name: string, data: unknown, options: unknown) {
        added.push({ name, data, options, thisValue: this });
        return Promise.resolve({ id: "job_1" });
      },
      addBulk(jobs: unknown[]) {
        added.push(jobs);
        return Promise.resolve(jobs);
      },
    };
    const wrapped = withCrumbtrailBullMqProducer(queue, {
      context: token(),
    });

    const data = { paymentId: "pay_1" };
    await wrapped.add?.("record-payment", data, { attempts: 4 });
    await wrapped.addBulk?.([
      { name: "record-payment", data, opts: { attempts: 4 } },
      { name: "send-receipt", data: { paymentId: "pay_2" } },
    ]);

    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({
      name: "record-payment",
      options: { attempts: 4 },
    });
    expect((added[0] as { data: Record<string, unknown> }).data).toMatchObject(
      { paymentId: "pay_1", __crumbtrail: { v: 1 } },
    );
    expect(data).toEqual({ paymentId: "pay_1" });
    expect(added[1]).toMatchObject([
      {
        name: "record-payment",
        data: { paymentId: "pay_1", __crumbtrail: { v: 1 } },
        opts: { attempts: 4 },
      },
      {
        name: "send-receipt",
        data: { paymentId: "pay_2", __crumbtrail: { v: 1 } },
      },
    ]);
    expect(withCrumbtrailBullMqProducer(wrapped, { context: token() })).toBe(
      wrapped,
    );
  });

  it("rejects a missing BullMQ Queue dependency at the explicit boundary", () => {
    expect(() => withCrumbtrailBullMqProducer({})).toThrow(
      /Queue\.add.*install BullMQ/,
    );
  });

  it("strips the carrier before the processor and preserves retry identity", async () => {
    const originalData = {
      orderId: "order_1",
      __crumbtrail: token(),
      __crumbtrailEnvelope: 1,
    };
    const originalJob: BullMqJobLike = {
      name: "record-payment",
      queueName: "payments",
      id: "job_991",
      attemptsMade: 2,
      data: originalData,
      opts: { jobId: "job_991", attempts: 4 },
    };
    const seen: Array<{ job: BullMqJobLike; context: string }> = [];
    const handler = vi.fn(async (job: BullMqJobLike, context) => {
      seen.push({ job, context: context.traceparent });
      return "ok";
    });
    const wrapped = withCrumbtrailBullMqProcessor(handler, {
      job: { now: () => Date.now() },
    });

    await expect(wrapped(originalJob)).resolves.toBe("ok");
    expect(handler).toHaveBeenCalledOnce();
    expect(seen[0]?.job).toMatchObject({
      name: "record-payment",
      queueName: "payments",
      id: "job_991",
      attemptsMade: 2,
      data: { orderId: "order_1" },
    });
    expect(seen[0]?.job.data).not.toHaveProperty("__crumbtrail");
    expect(seen[0]?.context).toMatch(
      /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/,
    );
    expect(originalJob.data).toEqual(originalData);
  });

  it("does not double wrap a processor callback", () => {
    const handler = () => "ok";
    const wrapped = withCrumbtrailBullMqProcessor(handler);
    expect(withCrumbtrailBullMqProcessor(wrapped)).toBe(wrapped);
  });
});
