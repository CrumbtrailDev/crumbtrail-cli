import { describe, expect, it, vi } from "vitest";
import {
  AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE,
  extractCrumbtrailEventBridgeContext,
  extractCrumbtrailSchedulerContext,
  extractCrumbtrailSnsRecord,
  extractCrumbtrailSqsRecord,
  injectCrumbtrailEventBridgeEntry,
  injectCrumbtrailSchedulerInput,
  injectCrumbtrailSnsMessage,
  injectCrumbtrailSqsBatch,
  injectCrumbtrailSqsMessage,
  stripCrumbtrailEventBridgeContext,
  stripCrumbtrailSchedulerContext,
  withCrumbtrailAwsEventBridgeProcessor,
  withCrumbtrailAwsEventBridgeProducer,
  withCrumbtrailAwsSchedulerProcessor,
  withCrumbtrailAwsSchedulerProducer,
  withCrumbtrailAwsSnsProcessor,
  withCrumbtrailAwsSnsProducer,
  withCrumbtrailAwsSqsBatchProcessor,
  withCrumbtrailAwsSqsProcessor,
  withCrumbtrailAwsSqsProducer,
  type AwsEventBridgeEntry,
  type AwsEventBridgeEvent,
  type AwsSchedulerCreateScheduleInput,
  type AwsSnsRecord,
  type AwsSqsRecord,
} from "../aws";
import type { CrumbtrailContextToken } from "../../distributed-context";

function token(now = Date.now()): CrumbtrailContextToken {
  return {
    v: 1,
    sessionId: "session_parent",
    requestId: "request_parent",
    traceparent:
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    enqueuedAt: now - 100,
    expiresAt: now + 60_000,
  };
}

function attrToken(now = Date.now()): {
  DataType: string;
  StringValue: string;
} {
  return {
    DataType: "String",
    StringValue: JSON.stringify(token(now)),
  };
}

describe("AWS event carriers", () => {
  it("uses SQS message attributes and preserves body and FIFO fields", () => {
    const input = {
      QueueUrl: "https://sqs.example/payments.fifo",
      MessageBody: JSON.stringify({ paymentId: "pay_1" }),
      MessageGroupId: "payments",
      MessageDeduplicationId: "dedupe_1",
      MessageAttributes: { Existing: { DataType: "String", StringValue: "x" } },
    };
    const carried = injectCrumbtrailSqsMessage(input, { context: token() });

    expect(carried).not.toBe(input);
    expect(carried).toMatchObject({
      QueueUrl: input.QueueUrl,
      MessageBody: input.MessageBody,
      MessageGroupId: "payments",
      MessageDeduplicationId: "dedupe_1",
      MessageAttributes: {
        Existing: { StringValue: "x" },
        [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: { DataType: "String" },
      },
    });
    expect(extractCrumbtrailSqsRecord({
      messageAttributes: carried.MessageAttributes,
    })).toMatchObject({ sessionId: "session_parent" });
    expect(input.MessageAttributes).not.toHaveProperty(
      AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE,
    );
  });

  it("uses SNS message attributes without changing the message", () => {
    const input = {
      TopicArn: "arn:aws:sns:ca-central-1:123:payments",
      Message: "payment-created",
      MessageStructure: "json",
    };
    const carried = injectCrumbtrailSnsMessage(input, { context: token() });

    expect(carried).toMatchObject({
      TopicArn: input.TopicArn,
      Message: input.Message,
      MessageStructure: "json",
      MessageAttributes: {
        [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: { DataType: "String" },
      },
    });
    expect(extractCrumbtrailSnsRecord({
      Sns: { MessageAttributes: carried.MessageAttributes },
    })).toMatchObject({ requestId: "request_parent" });
  });

  it("adds attributes to every SQS batch entry and preserves entry IDs", () => {
    const input = {
      QueueUrl: "https://sqs.example/jobs",
      Entries: [
        { Id: "a", MessageBody: "a", MessageGroupId: "one" },
        { Id: "b", MessageBody: "b", MessageDeduplicationId: "two" },
      ],
    };
    const carried = injectCrumbtrailSqsBatch(input, { context: token() });
    expect(carried.Entries.map((entry) => entry.Id)).toEqual(["a", "b"]);
    expect(carried.Entries.map((entry) => entry.MessageBody)).toEqual(["a", "b"]);
    expect(carried.Entries.every((entry) =>
      entry.MessageAttributes?.[AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE],
    )).toBe(true);
    expect(input.Entries[0]).not.toHaveProperty("MessageAttributes");
  });

  it("uses namespaced JSON for EventBridge and strips it on receipt", () => {
    const entry: AwsEventBridgeEntry = {
      Detail: JSON.stringify({ paymentId: "pay_1" }),
      Source: "payments",
      DetailType: "created",
    };
    const carried = injectCrumbtrailEventBridgeEntry(entry, {
      context: token(),
    });
    const detail = JSON.parse(carried.Detail as string) as Record<string, unknown>;
    const event: AwsEventBridgeEvent = { id: "evt_1", source: "payments", detail };
    expect(detail).toMatchObject({ paymentId: "pay_1", __crumbtrail: { v: 1 } });
    expect(extractCrumbtrailEventBridgeContext(event)).toMatchObject({
      sessionId: "session_parent",
    });
    expect(stripCrumbtrailEventBridgeContext(detail)).toEqual({
      paymentId: "pay_1",
    });
    expect(entry.Detail).not.toContain("__crumbtrail");
  });

  it("wraps non object EventBridge detail and restores the original value", () => {
    const carried = injectCrumbtrailEventBridgeEntry(
      { Detail: JSON.stringify("payment-created") },
      { context: token() },
    );
    const detail = JSON.parse(carried.Detail as string);
    expect(extractCrumbtrailEventBridgeContext({ detail })).toBeDefined();
    expect(stripCrumbtrailEventBridgeContext(detail)).toBe("payment-created");
  });

  it("links one shot Scheduler inputs and leaves recurring schedules unlinked", () => {
    const oneShot: AwsSchedulerCreateScheduleInput = {
      Name: "pay-once",
      ScheduleExpression: "at(2026-09-02T20:00:00)",
      Target: { Arn: "arn:lambda:pay", Input: JSON.stringify({ paymentId: "p1" }) },
    };
    const recurring: AwsSchedulerCreateScheduleInput = {
      Name: "reconcile",
      ScheduleExpression: "rate(5 minutes)",
      Target: { Arn: "arn:lambda:reconcile", Input: JSON.stringify({ mode: "all" }) },
    };
    const oneShotCarried = injectCrumbtrailSchedulerInput(oneShot, {
      context: token(1_000),
      now: 1_000,
    });
    const recurringCarried = injectCrumbtrailSchedulerInput(recurring, {
      context: token(1_000),
      now: 1_000,
    });
    const oneShotInput = JSON.parse(oneShotCarried.Target?.Input as string);
    expect(extractCrumbtrailSchedulerContext(oneShotInput, 1_000)).toMatchObject({
      sessionId: "session_parent",
      expiresAt: 61_000,
    });
    expect(stripCrumbtrailSchedulerContext(oneShotInput, 1_000)).toEqual({
      paymentId: "p1",
    });
    expect(recurringCarried).toEqual(recurring);
  });
});

describe("AWS structural producer wrappers", () => {
  it("wraps direct SQS and SNS methods without a runtime SDK dependency", async () => {
    const sqsCalls: unknown[] = [];
    const sqs = {
      sendMessage(input: unknown) {
        sqsCalls.push(input);
        return Promise.resolve("sqs-ok");
      },
      sendMessageBatch(input: unknown) {
        sqsCalls.push(input);
        return Promise.resolve("sqs-batch-ok");
      },
    };
    const wrappedSqs = withCrumbtrailAwsSqsProducer(sqs, { context: token() });
    await wrappedSqs.sendMessage?.({ MessageBody: "body" });
    await wrappedSqs.sendMessageBatch?.({
      Entries: [{ Id: "1", MessageBody: "body" }],
    });
    expect(sqsCalls).toHaveLength(2);
    expect((sqsCalls[0] as { MessageBody: string }).MessageBody).toBe("body");
    expect(
      (sqsCalls[0] as { MessageAttributes: Record<string, unknown> })
        .MessageAttributes[AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE],
    ).toBeDefined();
    expect(withCrumbtrailAwsSqsProducer(wrappedSqs, { context: token() })).toBe(
      wrappedSqs,
    );

    const snsCalls: unknown[] = [];
    const sns = {
      publish(input: unknown) {
        snsCalls.push(input);
        return Promise.resolve("sns-ok");
      },
    };
    const wrappedSns = withCrumbtrailAwsSnsProducer(sns, { context: token() });
    await wrappedSns.publish?.({ Message: "message" });
    expect(
      (snsCalls[0] as { MessageAttributes: Record<string, unknown> })
        .MessageAttributes[AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE],
    ).toBeDefined();
  });

  it("wraps AWS SDK v3 style commands by constructor name and clones input", async () => {
    class SendMessageCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    const seen: unknown[] = [];
    const sqs = {
      send(command: SendMessageCommand) {
        seen.push(command);
        return Promise.resolve(command.input);
      },
    };
    const wrapped = withCrumbtrailAwsSqsProducer(sqs, { context: token() });
    const input = { MessageBody: "body" };
    const command = new SendMessageCommand(input);
    await wrapped.send?.(command);
    expect(seen[0]).not.toBe(command);
    expect((seen[0] as SendMessageCommand).input).toMatchObject({
      MessageBody: "body",
      MessageAttributes: {
        [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: { DataType: "String" },
      },
    });
    expect(input).not.toHaveProperty("MessageAttributes");
  });

  it("wraps EventBridge and Scheduler commands with their structural carriers", async () => {
    class PutEventsCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    class CreateScheduleCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    const eventBridgeSeen: unknown[] = [];
    const eventBridge = {
      send(command: PutEventsCommand) {
        eventBridgeSeen.push(command);
        return Promise.resolve(command.input);
      },
    };
    const wrappedEventBridge = withCrumbtrailAwsEventBridgeProducer(eventBridge, {
      context: token(),
    });
    await wrappedEventBridge.send?.(
      new PutEventsCommand({
        Entries: [{ Detail: JSON.stringify({ paymentId: "p1" }) }],
      }),
    );
    expect(
      JSON.parse(
        ((eventBridgeSeen[0] as PutEventsCommand).input.Entries as Array<{ Detail: string }>)[0]
          .Detail,
      ),
    ).toMatchObject({ __crumbtrail: { v: 1 }, paymentId: "p1" });

    const schedulerSeen: unknown[] = [];
    const scheduler = {
      send(command: CreateScheduleCommand) {
        schedulerSeen.push(command);
        return Promise.resolve(command.input);
      },
    };
    const wrappedScheduler = withCrumbtrailAwsSchedulerProducer(scheduler, {
      context: token(),
    });
    await wrappedScheduler.send?.(
      new CreateScheduleCommand({
        ScheduleExpression: "rate(5 minutes)",
        Target: { Input: JSON.stringify({ mode: "all" }) },
      }),
    );
    expect((schedulerSeen[0] as CreateScheduleCommand).input).toMatchObject({
      ScheduleExpression: "rate(5 minutes)",
      Target: { Input: JSON.stringify({ mode: "all" }) },
    });
  });

  it("fails clearly when an optional AWS dependency is absent", () => {
    expect(() => withCrumbtrailAwsSqsProducer({})).toThrow(/install the AWS SDK/);
    expect(() => withCrumbtrailAwsSnsProducer({})).toThrow(/client\.send/);
    expect(() => withCrumbtrailAwsEventBridgeProducer({})).toThrow(
      /client\.send/,
    );
    expect(() => withCrumbtrailAwsSchedulerProducer({})).toThrow(
      /client\.send/,
    );
  });
});

describe("AWS processor wrappers", () => {
  it("uses SQS receive count as attempt and strips its metadata attribute", async () => {
    const record: AwsSqsRecord = {
      messageId: "message_1",
      body: "payload",
      messageAttributes: { [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: attrToken(1_000) },
      attributes: { ApproximateReceiveCount: "3" },
      eventSourceARN: "arn:aws:sqs:ca-central-1:123:payments",
    };
    const events: Array<Record<string, unknown>> = [];
    const handler = vi.fn(async (safeRecord: AwsSqsRecord, context) => {
      expect(safeRecord.messageAttributes).not.toHaveProperty(
        AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE,
      );
      return context.traceparent;
    });
    const wrapped = withCrumbtrailAwsSqsProcessor(handler, {
      now: 1_000,
      job: {
        sink: {
          sessionId: "parent",
          record: async (value) => {
            const list = Array.isArray(value) ? value : [value];
            events.push(...(list as Array<Record<string, unknown>>));
          },
        },
      },
    });
    await expect(wrapped(record)).resolves.toMatch(
      /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(record.messageAttributes).toHaveProperty(
      AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE,
    );
    expect(events.some((event) =>
      (event.d as Record<string, unknown> | undefined)?.attempt === 3,
    )).toBe(true);
  });

  it("returns only failed SQS item IDs for partial batch retries", async () => {
    const handler = vi.fn(async (record: AwsSqsRecord) => {
      if (record.messageId === "failed") throw new Error("retry");
      return "ok";
    });
    const wrapped = withCrumbtrailAwsSqsBatchProcessor(handler, { now: 1_000 });
    await expect(
      wrapped({
        Records: [
          { messageId: "ok", body: "ok" },
          { messageId: "failed", body: "failed" },
        ],
      }),
    ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "failed" }] });
  });

  it("wraps SNS, EventBridge, and Scheduler processors", async () => {
    const snsRecord: AwsSnsRecord = {
      Sns: {
        MessageId: "sns_1",
        Message: "message",
        TopicArn: "arn:aws:sns:ca-central-1:123:payments",
        MessageAttributes: {
          [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: attrToken(1_000),
        },
      },
    };
    const snsHandler = vi.fn(async (record: AwsSnsRecord) => record.Sns?.Message);
    await expect(
      withCrumbtrailAwsSnsProcessor(snsHandler, { now: 1_000 })(snsRecord),
    ).resolves.toBe("message");
    expect(snsHandler.mock.calls[0]?.[0].Sns?.MessageAttributes).not.toHaveProperty(
      AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE,
    );

    const event: AwsEventBridgeEvent = {
      id: "event_1",
      source: "payments",
      detail: { paymentId: "p1", __crumbtrail: token(1_000) },
    };
    const eventHandler = vi.fn(async (safeEvent: AwsEventBridgeEvent) =>
      safeEvent.detail,
    );
    await expect(
      withCrumbtrailAwsEventBridgeProcessor(eventHandler, { now: 1_000 })(event),
    ).resolves.toEqual({ paymentId: "p1" });

    const schedulerInput = { id: "schedule_1", value: "p1", __crumbtrail: token(1_000) };
    const schedulerHandler = vi.fn(async (safeInput: Record<string, unknown>) => safeInput);
    await expect(
      withCrumbtrailAwsSchedulerProcessor(schedulerHandler, { now: 1_000 })(
        schedulerInput,
      ),
    ).resolves.toEqual({ id: "schedule_1", value: "p1" });
  });
});
