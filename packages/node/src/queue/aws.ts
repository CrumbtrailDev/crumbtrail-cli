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
export const MAX_AWS_CONTEXT_VALUE_LENGTH = 2_048;

export interface AwsContextOptions {
  readonly context?: CrumbtrailContextToken;
  readonly token?: CrumbtrailContextToken;
  readonly now?: number | (() => number);
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
  const token = resolveToken(options);
  if (!token) return cloneValue(input);
  return {
    ...cloneValue(input),
    MessageAttributes: withContextAttribute(input.MessageAttributes, token),
  } as T;
}

/** Add a token to every SQS batch entry while preserving IDs and retry fields. */
export function injectCrumbtrailSqsBatch<T extends AwsSqsSendMessageBatchInput>(
  input: T,
  options: AwsContextOptions = {},
): Omit<T, "Entries"> & AwsSqsSendMessageBatchInput {
  const token = resolveToken(options);
  const cloned = cloneValue(input);
  if (!token) return cloned;
  return {
    ...cloned,
    Entries: input.Entries.map((entry) => ({
      ...cloneValue(entry),
      MessageAttributes: withContextAttribute(entry.MessageAttributes, token),
    })),
  } as T;
}

/** Add a token to an SNS publish attribute without changing the message body. */
export function injectCrumbtrailSnsMessage<T extends AwsSnsPublishInput>(
  input: T,
  options: AwsContextOptions = {},
): T & AwsSnsPublishInput {
  const token = resolveToken(options);
  if (!token) return cloneValue(input);
  return {
    ...cloneValue(input),
    MessageAttributes: withContextAttribute(input.MessageAttributes, token),
  } as T;
}

/** Add a token to EventBridge Detail JSON, whose envelope has no metadata field. */
export function injectCrumbtrailEventBridgeEntry<
  T extends AwsEventBridgeEntry,
>(input: T, options: AwsContextOptions = {}): T {
  const token = resolveToken(options);
  if (!token || typeof input.Detail !== "string") return cloneValue(input);
  const detail = injectJsonCarrier(input.Detail, token);
  return { ...cloneValue(input), Detail: detail } as T;
}

/**
 * Add a token to a Scheduler target only for one-shot `at(...)` schedules.
 * Recurring `rate(...)` and `cron(...)` schedules intentionally remain
 * unlinked, because they have no enqueueing request to continue.
 */
export function injectCrumbtrailSchedulerInput<
  T extends AwsSchedulerCreateScheduleInput,
>(input: T, options: AwsSchedulerProducerOptions = {}): T {
  const expressionIsOneShot = isOneShotSchedule(input.ScheduleExpression);
  const oneShot = expressionIsOneShot && options.oneShot !== false;
  const token = oneShot ? resolveToken(options) : undefined;
  if (!token || !input.Target || typeof input.Target.Input !== "string")
    return cloneValue(input);
  return {
    ...cloneValue(input),
    Target: {
      ...cloneValue(input.Target),
      Input: injectJsonCarrier(input.Target.Input, token),
    },
  } as T;
}

/** Extract a token from an incoming SQS record. */
export function extractCrumbtrailSqsRecord(
  record: AwsSqsRecord,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  return extractMessageAttribute(record.messageAttributes, now);
}

/** Extract a token from an incoming SNS record. */
export function extractCrumbtrailSnsRecord(
  record: AwsSnsRecord,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  return extractMessageAttribute(record.Sns?.MessageAttributes, now);
}

/** Extract a token from EventBridge detail JSON. */
export function extractCrumbtrailEventBridgeContext(
  event: AwsEventBridgeEvent,
  now: number | (() => number) = Date.now,
): CrumbtrailContextToken | undefined {
  return extractJsonCarrier(event.detail, now);
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
    const now = readNow(options.now);
    const token =
      extractCrumbtrailSqsRecord(record, now) ?? resolveToken(options, now);
    const safeRecord = stripSqsRecord(record);
    return withCrumbtrailJob(
      jobOptions(options, {
        name: options.name ?? "sqs-message",
        queue: options.queue ?? queueFromArn(record.eventSourceARN),
        jobId: record.messageId,
        attempt: receiveAttempt(record.attributes?.ApproximateReceiveCount),
        context: token,
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
    const results = await Promise.allSettled(
      event.Records.map((record) => processRecord(record)),
    );
    const failures = event.Records.flatMap((record, index) =>
      results[index]?.status === "rejected" && record.messageId
        ? [{ itemIdentifier: record.messageId }]
        : [],
    );
    return {
      batchItemFailures: failures.length
        ? failures
        : [{ itemIdentifier: "" }],
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
    const now = readNow(options.now);
    const token =
      extractCrumbtrailSnsRecord(record, now) ?? resolveToken(options, now);
    const safeRecord = stripSnsRecord(record);
    return withCrumbtrailJob(
      jobOptions(options, {
        name: options.name ?? "sns-message",
        queue: options.queue ?? topicFromArn(record.Sns?.TopicArn),
        jobId: record.Sns?.MessageId,
        attempt: 1,
        context: token,
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
    const now = readNow(options.now);
    const token =
      extractCrumbtrailEventBridgeContext(event, now) ??
      resolveToken(options, now);
    const safeEvent = {
      ...event,
      detail: stripCrumbtrailEventBridgeContext(event.detail, now),
    };
    return withCrumbtrailJob(
      jobOptions(options, {
        name: options.name ?? "eventbridge-event",
        queue: options.queue ?? event.source,
        jobId: event.id,
        attempt: 1,
        context: token,
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
    const now = readNow(options.now);
    const token =
      extractCrumbtrailSchedulerContext(event, now) ?? resolveToken(options, now);
    const safeEvent = stripCrumbtrailSchedulerContext(event, now);
    return withCrumbtrailJob(
      jobOptions(options, {
        name: options.name ?? "scheduler-invocation",
        queue: options.queue,
        jobId: stringValue(event.id),
        attempt: 1,
        context: token,
        now,
      }),
      (context) => handler(safeEvent as Record<string, unknown>, context),
    );
  };
}

type AwsWrapperKind = "sqs" | "sns" | "eventbridge" | "scheduler";
const CLIENT_WRAPPERS = new WeakMap<object, Map<AwsWrapperKind, AwsClientLike>>();

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
  const hasSend = typeof client.send === "function";
  const hasDirect = directMethods.some(
    (method) => typeof Reflect.get(client, method) === "function",
  );
  if (!hasSend && !hasDirect)
    throw new TypeError(
      `withCrumbtrailAws${kind}Producer requires client.send or ${directMethods.join("/")}; install the AWS SDK in the host application`,
    );

  const wrapped = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (directMethods.includes(String(property))) {
        return function crumbtrailAwsDirectSend(
          this: unknown,
          ...args: readonly unknown[]
        ): unknown {
          return Reflect.apply(value, this === undefined ? target : this, [
            wrapAwsInput(kind, args[0], options),
            ...args.slice(1),
          ]);
        };
      }
      if (property === "send") {
        return function crumbtrailAwsCommandSend(
          this: unknown,
          ...args: readonly unknown[]
        ): unknown {
          return Reflect.apply(value, this === undefined ? target : this, [
            wrapAwsCommand(kind, args[0], options),
            ...args.slice(1),
          ]);
        };
      }
      return value;
    },
  });
  let byKind = CLIENT_WRAPPERS.get(client);
  if (!byKind) {
    byKind = new Map();
    CLIENT_WRAPPERS.set(client, byKind);
  }
  byKind.set(kind, wrapped);
  let wrappedByKind = CLIENT_WRAPPERS.get(wrapped);
  if (!wrappedByKind) {
    wrappedByKind = new Map();
    CLIENT_WRAPPERS.set(wrapped, wrappedByKind);
  }
  wrappedByKind.set(kind, wrapped);
  return wrapped as TClient;
}

function wrapAwsInput(
  kind: AwsWrapperKind,
  input: unknown,
  options: AwsContextOptions,
): unknown {
  if (!input || typeof input !== "object") return input;
  switch (kind) {
    case "sqs":
      return "Entries" in input
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
}

function wrapAwsCommand(
  kind: AwsWrapperKind,
  command: unknown,
  options: AwsContextOptions,
): unknown {
  if (!command || typeof command !== "object") return command;
  const input = (command as { input?: unknown }).input;
  if (!input || typeof input !== "object") return command;
  const name = String(
    (command as { commandName?: unknown }).commandName ??
      (command as { constructor?: { name?: string } }).constructor?.name ??
        ""
  ).toLowerCase();
  const shouldWrap =
    (kind === "sqs" && /sendmessage/.test(name)) ||
    (kind === "sns" && /publish/.test(name)) ||
    (kind === "eventbridge" && /putevents/.test(name)) ||
    (kind === "scheduler" && /(createschedule|updateschedule)/.test(name));
  return shouldWrap ? cloneCommand(command, wrapAwsInput(kind, input, options)) : command;
}

function wrapEventBridgePutEvents(
  input: Record<string, unknown>,
  options: AwsContextOptions,
): Record<string, unknown> {
  const token = resolveToken(options);
  const entries = input.Entries;
  const cloned = cloneValue(input);
  if (!token || !Array.isArray(entries)) return cloned;
  return {
    ...cloned,
    Entries: entries.map((entry) =>
      entry && typeof entry === "object"
        ? injectCrumbtrailEventBridgeEntry(entry as AwsEventBridgeEntry, {
            ...options,
            context: token,
          })
        : entry,
    ),
  };
}

function cloneCommand(command: object, input: unknown): object {
  const cloned = Object.create(Object.getPrototypeOf(command));
  const descriptors = Object.getOwnPropertyDescriptors(command);
  delete descriptors.input;
  Object.defineProperties(cloned, descriptors);
  Object.defineProperty(cloned, "input", {
    configurable: true,
    enumerable: true,
    value: input,
    writable: true,
  });
  return cloned;
}

function jobOptions(
  options: AwsJobProcessorOptions,
  values: Pick<CrumbtrailJobOptions, "name" | "queue" | "jobId" | "attempt" | "context"> & {
    now: number;
  },
): CrumbtrailJobOptions {
  const { now, ...jobValues } = values;
  return {
    ...(options.job ?? {}),
    ...jobValues,
    now: options.job?.now ?? (() => now),
  };
}

function resolveToken(
  options: AwsContextOptions,
  now: number | (() => number) = options.now ?? Date.now,
): CrumbtrailContextToken | undefined {
  const explicit = options.context ?? options.token;
  const at = readNow(now);
  const validated = explicit
    ? validateCrumbtrailContextToken(explicit, at)
    : captureToken({ now: at });
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
}

function withContextAttribute(
  attributes: AwsMessageAttributes | undefined,
  token: CrumbtrailContextToken,
): AwsMessageAttributes {
  const value = JSON.stringify(token);
  if (value.length > MAX_AWS_CONTEXT_VALUE_LENGTH) return { ...attributes };
  return {
    ...(cloneValue(attributes ?? {}) as AwsMessageAttributes),
    [AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE]: {
      DataType: "String",
      StringValue: value,
    },
  };
}

function extractMessageAttribute(
  attributes: AwsMessageAttributes | undefined,
  now: number | (() => number),
): CrumbtrailContextToken | undefined {
  if (!attributes) return undefined;
  const attribute = Object.entries(attributes).find(
    ([key]) =>
      key === AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE ||
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
  try {
    return validateCrumbtrailContextToken(JSON.parse(value), now);
  } catch {
    return undefined;
  }
}

function injectJsonCarrier(
  encoded: string,
  token: CrumbtrailContextToken,
): string {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    const carried = injectJsonValue(parsed, token);
    const serialized = JSON.stringify(carried);
    return serialized.length <= MAX_AWS_CONTEXT_VALUE_LENGTH
      ? serialized
      : encoded;
  } catch {
    const carried = {
      [AWS_CRUMBTRAIL_CONTEXT_FIELD]: token,
      [AWS_CRUMBTRAIL_PAYLOAD_FIELD]: encoded,
    };
    const serialized = JSON.stringify(carried);
    return serialized.length <= MAX_AWS_CONTEXT_VALUE_LENGTH
      ? serialized
      : encoded;
  }
}

function injectJsonValue(
  value: unknown,
  token: CrumbtrailContextToken,
): unknown {
  if (isPlainRecord(value)) {
    return {
      ...cloneValue(value),
      [AWS_CRUMBTRAIL_CONTEXT_FIELD]: token,
    };
  }
  return {
    [AWS_CRUMBTRAIL_CONTEXT_FIELD]: token,
    [AWS_CRUMBTRAIL_PAYLOAD_FIELD]: value,
  };
}

function extractJsonCarrier(
  value: unknown,
  now: number | (() => number),
): CrumbtrailContextToken | undefined {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isPlainRecord(parsed)) return undefined;
  const candidate = parsed[AWS_CRUMBTRAIL_CONTEXT_FIELD];
  return validateCrumbtrailContextToken(candidate, now);
}

function stripJsonCarrier<T>(value: T, now: number | (() => number)): T {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  const token = extractJsonCarrier(value, now);
  if (!token || !isPlainRecord(parsed)) return cloneValue(value);
  if (AWS_CRUMBTRAIL_PAYLOAD_FIELD in parsed)
    return parsed[AWS_CRUMBTRAIL_PAYLOAD_FIELD] as T;
  const output = { ...cloneValue(parsed) } as Record<string, unknown>;
  delete output[AWS_CRUMBTRAIL_CONTEXT_FIELD];
  return (typeof value === "string" ? JSON.stringify(output) : output) as T;
}

function stripSqsRecord(record: AwsSqsRecord): AwsSqsRecord {
  if (!record.messageAttributes) return cloneValue(record);
  const attributes = { ...cloneValue(record.messageAttributes) } as AwsMessageAttributes;
  delete attributes[AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE];
  for (const key of Object.keys(attributes))
    if (key.toLowerCase() === AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE.toLowerCase())
      delete attributes[key];
  return { ...cloneValue(record), messageAttributes: attributes };
}

function stripSnsRecord(record: AwsSnsRecord): AwsSnsRecord {
  if (!record.Sns?.MessageAttributes) return cloneValue(record);
  const attributes = { ...cloneValue(record.Sns.MessageAttributes) } as AwsMessageAttributes;
  delete attributes[AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE];
  for (const key of Object.keys(attributes))
    if (key.toLowerCase() === AWS_CRUMBTRAIL_CONTEXT_ATTRIBUTE.toLowerCase())
      delete attributes[key];
  return {
    ...cloneValue(record),
    Sns: { ...cloneValue(record.Sns), MessageAttributes: attributes },
  };
}

function isOneShotSchedule(expression: string): boolean {
  return /^\s*at\s*\(/i.test(expression);
}

function receiveAttempt(value: string | undefined): number {
  const attempt = Number(value);
  return Number.isFinite(attempt) ? Math.max(1, Math.round(attempt)) : 1;
}

function queueFromArn(arn: string | undefined): string | undefined {
  return arn?.split(":").pop() || undefined;
}

function topicFromArn(arn: string | undefined): string | undefined {
  return arn?.split(":").pop() || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
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
  if (value.length > MAX_AWS_CONTEXT_VALUE_LENGTH) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through for host objects containing functions or SDK internals.
    }
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    output[key] = cloneValue(item);
  return output as T;
}
