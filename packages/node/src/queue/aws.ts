import {
  captureToken,
  DEFAULT_CONTEXT_TOKEN_TTL_MS,
  validateCrumbtrailContextToken,
  type CrumbtrailContextToken,
} from "../distributed-context";
import {
  withCrumbtrailJob,
  type CrumbtrailJobContext,
  type CrumbtrailJobOptions,
} from "../jobs";

/** Reserved, namespaced AWS message attribute used by SQS and SNS. */
export const AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE = "Crumbtrail.Context";
/** Reserved field used only when an AWS detail or input has no metadata channel. */
export const AWS_CRUMBTRAIL_CONTEXT_FIELD = "__crumbtrail";
/** Internal envelope field for non-object EventBridge and Scheduler payloads. */
export const AWS_CRUMBTRAIL_PAYLOAD_FIELD = "__crumbtrailPayload";
/** Marker that distinguishes an adapter envelope from user fields. */
export const AWS_CRUMBTRAIL_ENVELOPE_FIELD = "__crumbtrailEnvelope";
export const MAX_AWS_CONTEXT_VALUE_LENGTH = 2_048;
/** EventBridge PutEvents requires the summed entry size to be below 1 MiB. */
export const MAX_AWS_EVENTBRIDGE_REQUEST_BYTES = 1024 * 1024;
/** EventBridge Scheduler limits Target.Input to 256 KiB. */
export const MAX_AWS_SCHEDULER_INPUT_BYTES = 256 * 1024;

export type AwsCaptureLossPhase = "context" | "collision" | "size";

export interface AwsContextOptions {
  readonly context?: CrumbtrailContextToken;
  readonly token?: CrumbtrailContextToken;
  readonly now?: number | (() => number);
  /** Capture failures are reported without changing the host operation. */
  readonly onCaptureLoss?: (
    error: unknown,
    phase: AwsCaptureLossPhase,
  ) => void;
}

export interface AwsJobProcessorOptions extends AwsContextOptions {
  readonly name?: string;
  readonly queue?: string;
  readonly job?: Omit<
    CrumbtrailJobOptions,
    "name" | "queue" | "jobId" | "attempt" | "context"
  >;
}

export interface AwsMessageAttribute {
  readonly DataType?: string;
  readonly StringValue?: string;
  readonly BinaryValue?: unknown;
  readonly Value?: string;
  readonly value?: string;
  readonly dataType?: string;
  readonly stringValue?: string;
  readonly binaryValue?: unknown;
  readonly [key: string]: unknown;
}

export type AwsMessageAttributes = Record<string, AwsMessageAttribute>;

export interface AwsSqsSendMessageInput {
  readonly QueueUrl?: string;
  readonly MessageBody: string;
  readonly MessageAttributes?: AwsMessageAttributes;
  readonly MessageSystemAttributes?: Record<string, unknown>;
  readonly MessageGroupId?: string;
  readonly MessageDeduplicationId?: string;
  readonly [key: string]: unknown;
}

export interface AwsSqsSendMessageBatchEntry {
  readonly Id: string;
  readonly MessageBody: string;
  readonly MessageAttributes?: AwsMessageAttributes;
  readonly MessageSystemAttributes?: Record<string, unknown>;
  readonly MessageGroupId?: string;
  readonly MessageDeduplicationId?: string;
  readonly [key: string]: unknown;
}

export interface AwsSqsSendMessageBatchInput {
  readonly QueueUrl?: string;
  readonly Entries: readonly AwsSqsSendMessageBatchEntry[];
  readonly [key: string]: unknown;
}

export interface AwsSnsPublishInput {
  readonly TopicArn?: string;
  readonly TargetArn?: string;
  readonly PhoneNumber?: string;
  readonly Message: string;
  readonly MessageAttributes?: AwsMessageAttributes;
  readonly MessageStructure?: string;
  readonly [key: string]: unknown;
}

export interface AwsSqsRecord {
  readonly messageId?: string;
  readonly body?: string;
  readonly messageAttributes?: AwsMessageAttributes;
  readonly attributes?: Record<string, string>;
  readonly eventSourceARN?: string;
  readonly eventSource?: string;
  readonly [key: string]: unknown;
}

export interface AwsSqsEvent<TRecord extends AwsSqsRecord = AwsSqsRecord> {
  readonly Records: readonly TRecord[];
}

export interface AwsSnsRecord {
  readonly EventSubscriptionArn?: string;
  readonly Sns?: {
    readonly Message?: string;
    readonly MessageId?: string;
    readonly TopicArn?: string;
    readonly MessageAttributes?: AwsMessageAttributes;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface AwsSnsEvent<TRecord extends AwsSnsRecord = AwsSnsRecord> {
  readonly Records: readonly TRecord[];
}

export interface AwsEventBridgeEntry {
  readonly Detail?: string;
  readonly Source?: string;
  readonly DetailType?: string;
  readonly EventBusName?: string;
  readonly Resources?: readonly string[];
  readonly Time?: string | Date;
  readonly TraceHeader?: string;
  readonly [key: string]: unknown;
}

export interface AwsEventBridgeEvent {
  readonly id?: string;
  readonly source?: string;
  readonly "detail-type"?: string;
  readonly detail?: unknown;
  readonly time?: string;
  readonly resources?: readonly string[];
  readonly traceHeader?: string;
  readonly [key: string]: unknown;
}

export interface AwsSchedulerCreateScheduleInput {
  readonly Name?: string;
  readonly ScheduleExpression: string;
  readonly Target?: {
    readonly Input?: string;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface AwsClientLike {
  send?: (...args: any[]) => unknown;
  [key: string]: unknown;
}

export interface AwsSqsProducerOptions extends AwsContextOptions {
  readonly queue?: string;
}

export interface AwsSnsProducerOptions extends AwsContextOptions {
  readonly topic?: string;
}

export interface AwsEventBridgeProducerOptions extends AwsContextOptions {
  readonly source?: string;
}

export interface AwsSchedulerProducerOptions extends AwsContextOptions {
  /** Set false to disable the carrier for an `at(...)` schedule. Recurring schedules never carry one. */
  readonly oneShot?: boolean;
}

export type AwsSqsRecordHandler<
  TRecord extends AwsSqsRecord = AwsSqsRecord,
  TResult = unknown,
> = (record: TRecord, context: CrumbtrailJobContext) => TResult | Promise<TResult>;

export type AwsSnsRecordHandler<
  TRecord extends AwsSnsRecord = AwsSnsRecord,
  TResult = unknown,
> = (record: TRecord, context: CrumbtrailJobContext) => TResult | Promise<TResult>;

export type AwsEventBridgeHandler<TResult = unknown> = (
  event: AwsEventBridgeEvent,
  context: CrumbtrailJobContext,
) => TResult | Promise<TResult>;

export type AwsSchedulerHandler<TResult = unknown> = (
  event: Record<string, unknown>,
  context: CrumbtrailJobContext,
) => TResult | Promise<TResult>;

export interface AwsSqsBatchResponse {
  readonly batchItemFailures: ReadonlyArray<{ itemIdentifier: string }>;
}

/** Add a token to an SQS message attribute without changing body or FIFO fields. */
export function injectCrumbtrailSqsMessage<T extends AwsSqsSendMessageInput>(
  input: T,
  options: AwsContextOptions = {},
): T & AwsSqsSendMessageInput {
  try {
    const token = resolveToken(options);
    if (!token) return cloneValue(input);
    const messageAttributes = withContextAttribute(
      safeGet(input, "MessageAttributes") as AwsMessageAttributes | undefined,
      token,
      options,
    );
    if (!messageAttributes) return cloneValue(input);
    return {
      ...cloneValue(input),
      MessageAttributes: messageAttributes,
    } as T;
  } catch {
    return input as T & AwsSqsSendMessageInput;
  }
}

/** Add a token to every SQS batch entry while preserving IDs and retry fields. */
export function injectCrumbtrailSqsBatch<T extends AwsSqsSendMessageBatchInput>(
  input: T,
  options: AwsContextOptions = {},
): Omit<T, "Entries"> & AwsSqsSendMessageBatchInput {
  try {
    const token = resolveToken(options);
    const cloned = cloneValue(input);
    if (!token) return cloned;
    const entries = safeGet(input, "Entries");
    if (!Array.isArray(entries)) return cloned;
    return {
      ...cloned,
      Entries: entries.map((entry) => {
        const messageAttributes = withContextAttribute(
          safeGet(entry, "MessageAttributes") as
            | AwsMessageAttributes
            | undefined,
          token,
          options,
        );
        if (!messageAttributes) return cloneValue(entry);
        return {
          ...cloneValue(entry),
          MessageAttributes: messageAttributes,
        };
      }),
    } as T;
  } catch {
    return input as Omit<T, "Entries"> & AwsSqsSendMessageBatchInput;
  }
}

/** Add a token to an SNS publish attribute without changing the message body. */
export function injectCrumbtrailSnsMessage<T extends AwsSnsPublishInput>(
  input: T,
  options: AwsContextOptions = {},
): T & AwsSnsPublishInput {
  try {
    const token = resolveToken(options);
    if (!token) return cloneValue(input);
    const messageAttributes = withContextAttribute(
      safeGet(input, "MessageAttributes") as AwsMessageAttributes | undefined,
      token,
      options,
    );
    if (!messageAttributes) return cloneValue(input);
    return {
      ...cloneValue(input),
      MessageAttributes: messageAttributes,
    } as T;
  } catch {
    return input as T & AwsSnsPublishInput;
  }
}

/** Add a token to EventBridge Detail JSON, whose envelope has no metadata field. */
export function injectCrumbtrailEventBridgeEntry<
  T extends AwsEventBridgeEntry,
>(input: T, options: AwsContextOptions = {}): T {
  try {
    const token = resolveToken(options);
    const encoded = safeGet(input, "Detail");
    if (!token || typeof encoded !== "string") return cloneValue(input);
    const detail = injectJsonCarrier(encoded, token, options);
    const candidate = { ...cloneValue(input), Detail: detail } as T;
    if (eventBridgeEntryBytes(candidate) >= MAX_AWS_EVENTBRIDGE_REQUEST_BYTES) {
      reportCaptureLoss(
        options,
        "size",
        "EventBridge entry exceeds the 1 MiB PutEvents request limit with Crumbtrail context",
      );
      return cloneValue(input);
    }
    return candidate;
  } catch {
    return input;
  }
}

/**
 * Add a token to a Scheduler target only for one-shot `at(...)` schedules.
 * Recurring `rate(...)` and `cron(...)` schedules intentionally remain
 * unlinked, because they have no enqueueing request to continue.
 */
export function injectCrumbtrailSchedulerInput<
  T extends AwsSchedulerCreateScheduleInput,
>(input: T, options: AwsSchedulerProducerOptions = {}): T {
  try {
    const expressionIsOneShot = isOneShotSchedule(
      safeGet(input, "ScheduleExpression"),
    );
    const oneShot = expressionIsOneShot && safeGet(options, "oneShot") !== false;
    const token = oneShot ? resolveToken(options) : undefined;
    const target = safeGet(input, "Target");
    const encoded = safeGet(target, "Input");
    if (!token || !target || typeof encoded !== "string") return cloneValue(input);
    const carriedInput = injectJsonCarrier(encoded, token, options);
    const inputBytes = utf8Bytes(carriedInput);
    if (inputBytes > MAX_AWS_SCHEDULER_INPUT_BYTES) {
      reportCaptureLoss(
        options,
        "size",
        "Scheduler Target.Input exceeds the 256 KiB service limit with Crumbtrail context",
      );
      return cloneValue(input);
    }
    return {
      ...cloneValue(input),
      Target: {
        ...cloneValue(target),
        Input: carriedInput,
      },
    } as T;
  } catch {
    return input;
  }
}

/** Extract a token from an incoming SQS record. */
export function extractCrumbtrailSqsRecord(
  record: AwsSqsRecord,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  return extractMessageAttribute(
    safeGet(record, "messageAttributes") as AwsMessageAttributes | undefined,
    now,
  );
}

/** Extract a token from an incoming SNS record. */
export function extractCrumbtrailSnsRecord(
  record: AwsSnsRecord,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  const sns = safeGet(record, "Sns");
  return extractMessageAttribute(
    safeGet(sns, "MessageAttributes") as AwsMessageAttributes | undefined,
    now,
  );
}

/** Extract a token from EventBridge detail JSON. */
export function extractCrumbtrailEventBridgeContext(
  event: AwsEventBridgeEvent,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  return extractJsonCarrier(safeGet(event, "detail"), now);
}

/** Extract a token from a Scheduler target input or direct invocation input. */
export function extractCrumbtrailSchedulerContext(
  input: unknown,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  return extractJsonCarrier(input, now);
}

/** Remove the reserved EventBridge field before passing detail to user code. */
export function stripCrumbtrailEventBridgeContext<T>(
  detail: T,
  now: number | (() => number) = Date.now,
): T {
  return stripJsonCarrier(detail, now);
}

/** Remove the reserved Scheduler field before passing input to user code. */
export function stripCrumbtrailSchedulerContext<T>(
  input: T,
  now: number | (() => number) = Date.now,
): T {
  return stripJsonCarrier(input, now);
}

/**
 * Wrap a structural SQS client. Both direct method clients and AWS SDK v3
 * clients exposing `send(command)` are supported. The command is cloned so
 * middleware state and caller inputs are not mutated.
 */
export function withCrumbtrailAwsSqsProducer<TClient extends AwsClientLike>(
  client: TClient,
  options: AwsSqsProducerOptions = {},
): TClient {
  return wrapAwsClient(client, "sqs", options, ["sendMessage", "sendMessageBatch"]);
}

export const wrapAwsSqsProducer = withCrumbtrailAwsSqsProducer;

/** Wrap a structural SNS client using MessageAttributes for context. */
export function withCrumbtrailAwsSnsProducer<TClient extends AwsClientLike>(
  client: TClient,
  options: AwsSnsProducerOptions = {},
): TClient {
  return wrapAwsClient(client, "sns", options, ["publish"]);
}

export const wrapAwsSnsProducer = withCrumbtrailAwsSnsProducer;

/** Wrap a structural EventBridge client using namespaced Detail JSON. */
export function withCrumbtrailAwsEventBridgeProducer<
  TClient extends AwsClientLike,
>(client: TClient, options: AwsEventBridgeProducerOptions = {}): TClient {
  return wrapAwsClient(client, "eventbridge", options, ["putEvents"]);
}

export const wrapAwsEventBridgeProducer = withCrumbtrailAwsEventBridgeProducer;

/** Wrap a structural Scheduler client with one-shot-only context injection. */
export function withCrumbtrailAwsSchedulerProducer<
  TClient extends AwsClientLike,
>(client: TClient, options: AwsSchedulerProducerOptions = {}): TClient {
  return wrapAwsClient(client, "scheduler", options, [
    "createSchedule",
    "updateSchedule",
  ]);
}

export const wrapAwsSchedulerProducer = withCrumbtrailAwsSchedulerProducer;

/** Wrap one SQS record processor and delegate capture lifecycle to the job API. */
export function withCrumbtrailAwsSqsProcessor<
  TRecord extends AwsSqsRecord,
  TResult = unknown,
>(
  handler: AwsSqsRecordHandler<TRecord, TResult>,
  options: AwsJobProcessorOptions = {},
): (record: TRecord) => Promise<TResult> {
  return async (record) => {
    const now = readNow(safeGet(options, "now") as number | (() => number) | undefined);
    const hasCarrier = hasReservedMessageAttribute(
      safeGet(record, "messageAttributes") as AwsMessageAttributes | undefined,
    );
    const extractedToken = hasCarrier
      ? extractCrumbtrailSqsRecord(record, now)
      : undefined;
    const token = hasCarrier ? extractedToken : resolveToken(options, now);
    const safeRecord = stripSqsRecord(record, now);
    const attributes = safeGet(record, "attributes");
    return withCrumbtrailJob(
      jobOptions(options, {
        name: safeText(safeGet(options, "name")) ?? "sqs-message",
        queue:
          safeText(safeGet(options, "queue")) ??
          queueFromArn(safeGet(record, "eventSourceARN")),
        jobId: safeText(safeGet(record, "messageId")),
        attempt: receiveAttempt(stringValue(safeGet(attributes, "ApproximateReceiveCount"))),
        context: processorContext(options, hasCarrier, token),
        now,
      }),
      (context) => handler(safeRecord as TRecord, context),
    );
  };
}

/**
 * Wrap an SQS batch handler with Lambda partial batch failure semantics. A
 * rejected record is returned as a failed item, while successful records are
 * acknowledged and the batch itself resolves.
 */
export function withCrumbtrailAwsSqsBatchProcessor<
  TRecord extends AwsSqsRecord,
  TResult = unknown,
>(
  handler: AwsSqsRecordHandler<TRecord, TResult>,
  options: AwsJobProcessorOptions = {},
): (event: AwsSqsEvent<TRecord>) => Promise<AwsSqsBatchResponse> {
  const processRecord = withCrumbtrailAwsSqsProcessor(handler, options);
  return async (event) => {
    const records = safeGet(event, "Records");
    if (!Array.isArray(records)) return { batchItemFailures: [] };
    const results = await Promise.allSettled(
      records.map((record) => processRecord(record as TRecord)),
    );
    const failures = records.flatMap((record, index) => {
      const itemIdentifier = safeText(safeGet(record, "messageId"));
      return results[index]?.status === "rejected" && itemIdentifier
        ? [{ itemIdentifier }]
        : [];
    });
    return {
      batchItemFailures: failures,
    } as AwsSqsBatchResponse;
  };
}

/** Wrap one SNS record processor and preserve the original record on success. */
export function withCrumbtrailAwsSnsProcessor<
  TRecord extends AwsSnsRecord,
  TResult = unknown,
>(
  handler: AwsSnsRecordHandler<TRecord, TResult>,
  options: AwsJobProcessorOptions = {},
): (record: TRecord) => Promise<TResult> {
  return async (record) => {
    const now = readNow(safeGet(options, "now") as number | (() => number) | undefined);
    const sns = safeGet(record, "Sns");
    const hasCarrier = hasReservedMessageAttribute(
      safeGet(sns, "MessageAttributes") as AwsMessageAttributes | undefined,
    );
    const extractedToken = hasCarrier
      ? extractCrumbtrailSnsRecord(record, now)
      : undefined;
    const token = hasCarrier ? extractedToken : resolveToken(options, now);
    const safeRecord = stripSnsRecord(record, now);
    return withCrumbtrailJob(
      jobOptions(options, {
        name: safeText(safeGet(options, "name")) ?? "sns-message",
        queue:
          safeText(safeGet(options, "queue")) ??
          topicFromArn(safeGet(sns, "TopicArn")),
        jobId: safeText(safeGet(sns, "MessageId")),
        attempt: 1,
        context: processorContext(options, hasCarrier, token),
        now,
      }),
      (context) => handler(safeRecord as TRecord, context),
    );
  };
}

/** Wrap one EventBridge invocation and strip its namespaced detail field. */
export function withCrumbtrailAwsEventBridgeProcessor<TResult = unknown>(
  handler: AwsEventBridgeHandler<TResult>,
  options: AwsJobProcessorOptions = {},
): (event: AwsEventBridgeEvent) => Promise<TResult> {
  return async (event) => {
    const now = readNow(safeGet(options, "now") as number | (() => number) | undefined);
    const detail = safeGet(event, "detail");
    const hasCarrier = hasJsonCarrier(detail);
    const extractedToken = hasCarrier
      ? extractCrumbtrailEventBridgeContext(event, now)
      : undefined;
    const token = hasCarrier ? extractedToken : resolveToken(options, now);
    const safeEvent = {
      ...event,
      detail: stripCrumbtrailEventBridgeContext(detail, now),
    };
    return withCrumbtrailJob(
      jobOptions(options, {
        name: safeText(safeGet(options, "name")) ?? "eventbridge-event",
        queue: safeText(safeGet(options, "queue")) ?? safeText(safeGet(event, "source")),
        jobId: safeText(safeGet(event, "id")),
        attempt: 1,
        context: processorContext(options, hasCarrier, token),
        now,
      }),
      (context) => handler(safeEvent, context),
    );
  };
}

/** Wrap one Scheduler invocation and strip its namespaced input field. */
export function withCrumbtrailAwsSchedulerProcessor<TResult = unknown>(
  handler: AwsSchedulerHandler<TResult>,
  options: AwsJobProcessorOptions = {},
): (event: Record<string, unknown>) => Promise<TResult> {
  return async (event) => {
    const now = readNow(safeGet(options, "now") as number | (() => number) | undefined);
    const hasCarrier = hasJsonCarrier(event);
    const extractedToken = hasCarrier
      ? extractCrumbtrailSchedulerContext(event, now)
      : undefined;
    const token = hasCarrier ? extractedToken : resolveToken(options, now);
    const safeEvent = stripCrumbtrailSchedulerContext(event, now);
    return withCrumbtrailJob(
      jobOptions(options, {
        name: safeText(safeGet(options, "name")) ?? "scheduler-invocation",
        queue: safeText(safeGet(options, "queue")),
        jobId: stringValue(safeGet(event, "id")),
        attempt: 1,
        context: processorContext(options, hasCarrier, token),
        now,
      }),
      (context) => handler(safeEvent as Record<string, unknown>, context),
    );
  };
}

type AwsWrapperKind = "sqs" | "sns" | "eventbridge" | "scheduler";
const CLIENT_WRAPPERS = new WeakMap<
  object,
  Map<AwsWrapperKind, AwsClientLike>
>();

function wrapAwsClient<TClient extends AwsClientLike>(
  client: TClient,
  kind: AwsWrapperKind,
  options: AwsContextOptions,
  directMethods: readonly string[],
): TClient {
  if (!client || typeof client !== "object")
    throw new TypeError(`withCrumbtrailAws${kind}Producer requires an AWS client`);
  const existing = CLIENT_WRAPPERS.get(client)?.get(kind);
  if (existing) return existing as TClient;
  const hasSend = typeof safeGet(client, "send") === "function";
  const hasDirect = directMethods.some(
    (method) => typeof safeGet(client, method) === "function",
  );
  if (!hasSend && !hasDirect)
    throw new TypeError(
      `withCrumbtrailAws${kind}Producer requires client.send or ${directMethods.join("/")}; install the AWS SDK in the host application`,
    );

  const wrapped = new Proxy(client, {
    get(target, property) {
      const value = safeGet(target, property);
      if (typeof value !== "function") return value;
      if (directMethods.includes(String(property))) {
        return function crumbtrailAwsDirectSend(
          this: unknown,
        ...args: readonly unknown[]
        ): unknown {
          let input = args[0];
          try {
            input = wrapAwsInput(kind, input, options);
          } catch {
            // The AWS operation remains authoritative when inspection fails.
          }
          return Reflect.apply(value, target, [
            input,
            ...args.slice(1),
          ]);
        };
      }
      if (property === "send") {
        return function crumbtrailAwsCommandSend(
          this: unknown,
        ...args: readonly unknown[]
        ): unknown {
          let command = args[0];
          try {
            command = wrapAwsCommand(kind, command, options);
          } catch {
            // The AWS operation remains authoritative when inspection fails.
          }
          return Reflect.apply(value, target, [
            command,
            ...args.slice(1),
          ]);
        };
      }
      return value.bind(target);
    },
  });
  markClientWrapper(client, wrapped, kind);
  return wrapped as TClient;
}

function wrapAwsInput(
  kind: AwsWrapperKind,
  input: unknown,
  options: AwsContextOptions,
): unknown {
  try {
    if (!input || typeof input !== "object") return input;
    switch (kind) {
      case "sqs":
        return safeHas(input, "Entries")
          ? injectCrumbtrailSqsBatch(input as AwsSqsSendMessageBatchInput, options)
          : injectCrumbtrailSqsMessage(input as AwsSqsSendMessageInput, options);
      case "sns":
        return injectCrumbtrailSnsMessage(input as AwsSnsPublishInput, options);
      case "eventbridge":
        return wrapEventBridgePutEvents(input as Record<string, unknown>, options);
      case "scheduler":
        return injectCrumbtrailSchedulerInput(
          input as AwsSchedulerCreateScheduleInput,
          options,
        );
    }
  } catch {
    return input;
  }
}

function wrapAwsCommand(
  kind: AwsWrapperKind,
  command: unknown,
  options: AwsContextOptions,
): unknown {
  try {
    if (!command || typeof command !== "object") return command;
    const input = safeGet(command, "input");
    if (!input || typeof input !== "object") return command;
    const commandName = safeGet(command, "commandName");
    const constructor = safeGet(command, "constructor");
    const name = stringValue(commandName ?? safeGet(constructor, "name"))
      ?.toLowerCase() ?? "";
    const shouldWrap =
      (kind === "sqs" && /sendmessage/.test(name)) ||
      (kind === "sns" && /publish/.test(name)) ||
      (kind === "eventbridge" && /putevents/.test(name)) ||
      (kind === "scheduler" && /(createschedule|updateschedule)/.test(name));
    return shouldWrap
      ? cloneCommand(command, wrapAwsInput(kind, input, options))
      : command;
  } catch {
    return command;
  }
}

function wrapEventBridgePutEvents(
  input: Record<string, unknown>,
  options: AwsContextOptions,
): Record<string, unknown> {
  try {
    const token = resolveToken(options);
    const entries = safeGet(input, "Entries");
    const cloned = cloneValue(input);
    if (!token || !Array.isArray(entries)) return cloned;
    const contextOptions = { ...options, context: token };
    const carriedEntries = entries.map((entry) =>
      entry && typeof entry === "object"
        ? injectCrumbtrailEventBridgeEntry(
            entry as AwsEventBridgeEntry,
            contextOptions,
          )
        : entry,
    );
    if (eventBridgeRequestBytes(carriedEntries) >= MAX_AWS_EVENTBRIDGE_REQUEST_BYTES) {
      reportCaptureLoss(
        options,
        "size",
        "EventBridge request exceeds the 1 MiB service limit with Crumbtrail context",
      );
      return cloned;
    }
    return {
      ...cloned,
      Entries: carriedEntries,
    };
  } catch {
    return input;
  }
}

function cloneCommand(command: object, input: unknown): object {
  return new Proxy(command, {
    get(target, property) {
      if (property === "input") return input;
      const value = safeGet(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function jobOptions(
  options: AwsJobProcessorOptions,
  values: Pick<CrumbtrailJobOptions, "name" | "queue" | "jobId" | "attempt" | "context"> & {
    now: number;
  },
): CrumbtrailJobOptions {
  const { now, ...jobValues } = values;
  const job = safeGet(options, "job");
  const jobNow = safeGet(job, "now");
  const clonedJob = cloneValue(job);
  return {
    ...(isObject(clonedJob) ? clonedJob : {}),
    ...jobValues,
    now: typeof jobNow === "function" ? (jobNow as () => number) : () => now,
  };
}

function resolveToken(
  options: AwsContextOptions,
  now: number | (() => number) =
    (safeGet(options, "now") as number | (() => number) | undefined) ?? Date.now,
): CrumbtrailContextToken | undefined {
  try {
    const explicit =
      (safeGet(options, "context") as CrumbtrailContextToken | undefined) ??
      (safeGet(options, "token") as CrumbtrailContextToken | undefined);
    const at = readNow(now);
    const validated = explicit
      ? validateCrumbtrailContextToken(explicit, at)
      : captureToken({ now: at });
    if (explicit && !validated) {
      reportCaptureLoss(
        options,
        "context",
        "AWS context token was invalid or expired",
      );
    }
    if (!validated) return undefined;
    const expiresAt = Math.min(
      validated.expiresAt ?? at + DEFAULT_CONTEXT_TOKEN_TTL_MS,
      at + DEFAULT_CONTEXT_TOKEN_TTL_MS,
    );
    return Object.freeze({
      ...validated,
      enqueuedAt: validated.enqueuedAt ?? at,
      expiresAt,
    });
  } catch {
    return undefined;
  }
}

function withContextAttribute(
  attributes: AwsMessageAttributes | undefined,
  token: CrumbtrailContextToken,
  options: AwsContextOptions,
): AwsMessageAttributes | undefined {
  try {
    const value = JSON.stringify(token);
    if (value.length > MAX_AWS_CONTEXT_VALUE_LENGTH) {
      reportCaptureLoss(
        options,
        "size",
        "Crumbtrail AWS context attribute exceeds its 2 KiB carrier limit",
      );
      return cloneValue(attributes ?? {});
    }
    const next = cloneValue(attributes ?? {}) as AwsMessageAttributes;
    if (
      Object.keys(next).some(
        (key) =>
          key.toLowerCase() === AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE.toLowerCase(),
      )
    ) {
      reportCaptureLoss(
        options,
        "collision",
        "AWS message attributes already contain the reserved Crumbtrail.Context name",
      );
      return undefined;
    }
    return {
      ...next,
      [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: {
        DataType: "String",
        StringValue: value,
      },
    };
  } catch {
    return undefined;
  }
}

function extractMessageAttribute(
  attributes: AwsMessageAttributes | undefined,
  now: number | (() => number),
): CrumbtrailContextToken | undefined {
  try {
    if (!attributes) return undefined;
    const attribute = Object.prototype.hasOwnProperty.call(
      attributes,
      AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE,
    )
      ? attributes[AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]
      : Object.entries(attributes).find(
          ([key]) =>
            key.toLowerCase() === AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE.toLowerCase(),
        )?.[1];
    const value =
      typeof attribute === "string"
        ? attribute
        : attribute?.StringValue ??
          attribute?.stringValue ??
          attribute?.Value ??
          attribute?.value;
    if (typeof value !== "string" || value.length > MAX_AWS_CONTEXT_VALUE_LENGTH)
      return undefined;
    return validateCrumbtrailContextToken(JSON.parse(value), now);
  } catch {
    return undefined;
  }
}

function injectJsonCarrier(
  encoded: string,
  token: CrumbtrailContextToken,
  options: AwsContextOptions,
): string {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    const carried = injectJsonValue(parsed, token, options);
    if (carried === undefined) return encoded;
    return JSON.stringify(carried);
  } catch {
    const carried = {
      [AWS_CRUMBTRAIL_CONTEXT_FIELD]: token,
      [AWS_CRUMBTRAIL_PAYLOAD_FIELD]: encoded,
      [AWS_CRUMBTRAIL_ENVELOPE_FIELD]: 1,
    };
    return JSON.stringify(carried);
  }
}

function injectJsonValue(
  value: unknown,
  token: CrumbtrailContextToken,
  options: AwsContextOptions,
): unknown | undefined {
  if (isPlainRecord(value)) {
    if (
      Object.prototype.hasOwnProperty.call(value, AWS_CRUMBTRAIL_CONTEXT_FIELD) ||
      Object.prototype.hasOwnProperty.call(value, AWS_CRUMBTRAIL_PAYLOAD_FIELD) ||
      Object.prototype.hasOwnProperty.call(value, AWS_CRUMBTRAIL_ENVELOPE_FIELD)
    ) {
      reportCaptureLoss(
        options,
        "collision",
        "AWS detail or input already contains a reserved Crumbtrail field",
      );
      return undefined;
    }
    return {
      ...cloneValue(value),
      [AWS_CRUMBTRAIL_CONTEXT_FIELD]: token,
      [AWS_CRUMBTRAIL_ENVELOPE_FIELD]: 1,
    };
  }
  return {
    [AWS_CRUMBTRAIL_CONTEXT_FIELD]: token,
    [AWS_CRUMBTRAIL_PAYLOAD_FIELD]: value,
    [AWS_CRUMBTRAIL_ENVELOPE_FIELD]: 1,
  };
}

function extractJsonCarrier(
  value: unknown,
  now: number | (() => number),
): CrumbtrailContextToken | undefined {
  try {
    const parsed = typeof value === "string" ? parseJson(value) : value;
    if (!isPlainRecord(parsed)) return undefined;
    if (safeGet(parsed, AWS_CRUMBTRAIL_ENVELOPE_FIELD) !== 1) return undefined;
    const candidate = safeGet(parsed, AWS_CRUMBTRAIL_CONTEXT_FIELD);
    return validateCrumbtrailContextToken(candidate, now);
  } catch {
    return undefined;
  }
}

function stripJsonCarrier<T>(value: T, now: number | (() => number)): T {
  try {
    const parsed = typeof value === "string" ? parseJson(value) : value;
    if (!hasJsonCarrier(value) || !isPlainRecord(parsed)) return cloneValue(value);
    if (safeHas(parsed, AWS_CRUMBTRAIL_PAYLOAD_FIELD))
      return safeGet(parsed, AWS_CRUMBTRAIL_PAYLOAD_FIELD) as T;
    const output = { ...cloneValue(parsed) } as Record<string, unknown>;
    delete output[AWS_CRUMBTRAIL_CONTEXT_FIELD];
    delete output[AWS_CRUMBTRAIL_ENVELOPE_FIELD];
    return (typeof value === "string" ? JSON.stringify(output) : output) as T;
  } catch {
    return value;
  }
}

function stripSqsRecord(
  record: AwsSqsRecord,
  now: number | (() => number),
): AwsSqsRecord {
  try {
    const source = safeGet(record, "messageAttributes") as
      | AwsMessageAttributes
      | undefined;
    if (!source || !hasReservedMessageAttribute(source)) return cloneValue(record);
    const attributes = cloneValue(source) as AwsMessageAttributes;
    for (const key of Object.keys(attributes)) {
      if (isReservedMessageAttribute(key)) delete attributes[key];
    }
    return { ...cloneValue(record), messageAttributes: attributes };
  } catch {
    return record;
  }
}

function stripSnsRecord(
  record: AwsSnsRecord,
  now: number | (() => number),
): AwsSnsRecord {
  try {
    const sns = safeGet(record, "Sns");
    const source = safeGet(sns, "MessageAttributes") as
      | AwsMessageAttributes
      | undefined;
    if (!source || !hasReservedMessageAttribute(source))
      return cloneValue(record);
    const attributes = cloneValue(source) as AwsMessageAttributes;
    for (const key of Object.keys(attributes)) {
      if (isReservedMessageAttribute(key)) delete attributes[key];
    }
    const clonedSns = cloneValue(sns);
    return {
      ...cloneValue(record),
      Sns: {
        ...(isObject(clonedSns) ? clonedSns : {}),
        MessageAttributes: attributes,
      },
    };
  } catch {
    return record;
  }
}

function isOneShotSchedule(expression: unknown): boolean {
  return typeof expression === "string" && /^\s*at\s*\(/i.test(expression);
}

function eventBridgeEntryBytes(entry: AwsEventBridgeEntry): number {
  let size = 0;
  if (entry.Time !== undefined && entry.Time !== null) size += 14;
  size += utf8BytesIfString(entry.Source);
  size += utf8BytesIfString(entry.DetailType);
  size += utf8BytesIfString(entry.Detail);
  if (Array.isArray(entry.Resources)) {
    for (const resource of entry.Resources) size += utf8BytesIfString(resource);
  }
  return size;
}

function eventBridgeRequestBytes(entries: readonly unknown[]): number {
  let size = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return Number.POSITIVE_INFINITY;
    size += eventBridgeEntryBytes(entry as AwsEventBridgeEntry);
  }
  return size;
}

function utf8BytesIfString(value: unknown): number {
  return typeof value === "string" ? utf8Bytes(value) : 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function receiveAttempt(value: string | undefined): number {
  const attempt = Number(value);
  return Number.isFinite(attempt) ? Math.max(1, Math.round(attempt)) : 1;
}

function queueFromArn(arn: unknown): string | undefined {
  return stringValue(arn)?.split(":").pop() || undefined;
}

function topicFromArn(arn: unknown): string | undefined {
  return stringValue(arn)?.split(":").pop() || undefined;
}

function stringValue(value: unknown): string | undefined {
  try {
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeText(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  return text ? text.slice(0, 256) : undefined;
}

function reportCaptureLoss(
  options: Pick<AwsContextOptions, "onCaptureLoss">,
  phase: AwsCaptureLossPhase,
  message: string,
): void {
  try {
    options.onCaptureLoss?.(new Error(message), phase);
  } catch {
    // Capture diagnostics must not replace the host operation.
  }
}

function readNow(now: number | (() => number) | undefined): number {
  try {
    const value = typeof now === "function" ? now() : (now ?? Date.now());
    return Number.isFinite(value) ? Math.round(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function cloneValue<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
    if (!isPlainRecord(value)) return value;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) output[key] = value[key];
    return output as T;
  } catch {
    // Host operations remain authoritative when defensive inspection is unsafe.
    return value;
  }
}

function safeGet(target: unknown, property: PropertyKey): unknown {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  )
    return undefined;
  try {
    return Reflect.get(target, property, target);
  } catch {
    return undefined;
  }
}

function safeHas(target: unknown, property: PropertyKey): boolean {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  )
    return false;
  try {
    return Reflect.has(target, property);
  } catch {
    return false;
  }
}

function markClientWrapper(
  client: object,
  wrapped: object,
  kind: AwsWrapperKind,
): void {
  for (const key of [client, wrapped]) {
    let wrappers = CLIENT_WRAPPERS.get(key);
    if (!wrappers) {
      wrappers = new Map();
      CLIENT_WRAPPERS.set(key, wrappers);
    }
    wrappers.set(kind, wrapped as AwsClientLike);
  }
}

function hasReservedMessageAttribute(
  attributes: AwsMessageAttributes | undefined,
): boolean {
  try {
    return (
      attributes !== undefined &&
      Object.keys(attributes).some(isReservedMessageAttribute)
    );
  } catch {
    return false;
  }
}

function isReservedMessageAttribute(key: string): boolean {
  return key.toLowerCase() === AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE.toLowerCase();
}

function hasJsonCarrier(value: unknown): boolean {
  try {
    const parsed = typeof value === "string" ? parseJson(value) : value;
    return (
      isPlainRecord(parsed) &&
      safeGet(parsed, AWS_CRUMBTRAIL_ENVELOPE_FIELD) === 1
    );
  } catch {
    return false;
  }
}

function processorContext(
  options: AwsJobProcessorOptions,
  hasCarrier: boolean,
  token: CrumbtrailContextToken | undefined,
): CrumbtrailContextToken | null | undefined {
  if (hasCarrier || (!token && hasExplicitContext(options))) return token ?? null;
  return token;
}

function hasExplicitContext(options: AwsContextOptions): boolean {
  return safeGet(options, "context") !== undefined || safeGet(options, "token") !== undefined;
}
