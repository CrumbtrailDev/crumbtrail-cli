import {
  checkApplicationResponse,
  createApplicationExpectationManager,
  buildApplicationExpectationMissedEvent,
  MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION,
  type ApplicationExpectationManager,
  type ApplicationExpectationOptions,
  type ApplicationExpectationResult,
  type ApplicationResponseCheckResult,
  type ApplicationResponseFactOptions,
} from "crumbtrail-core";
import {
  sendBackendEvent,
  type SendBackendEventOptions,
} from "./backend-intake";
import { getProcessSessionId } from "./process-session";
import { readRequestCorrelation } from "./request-context";

type ApplicationTransportOptions = Omit<
  SendBackendEventOptions,
  "event" | "sessionId"
>;

export interface SendApplicationResponseAssertionsOptions extends ApplicationTransportOptions {
  response: unknown;
  facts: readonly ApplicationResponseFactOptions[];
  sessionId?: string;
  requestId?: string;
  traceId?: string;
}

export interface SendApplicationResponseFactResult {
  accepted: boolean;
  passed?: boolean;
  rejection?: ApplicationResponseCheckResult["results"][number]["rejection"];
  delivered?: boolean;
  event?: ApplicationResponseCheckResult["results"][number]["event"];
}

export interface SendApplicationResponseAssertionsResult extends Omit<
  ApplicationResponseCheckResult,
  "results" | "rejection"
> {
  results: SendApplicationResponseFactResult[];
  rejection?:
    | ApplicationResponseCheckResult["rejection"]
    | "correlation_invalid"
    | "invalid_options";
}

export interface BeginApplicationExpectationOptions
  extends
    ApplicationTransportOptions,
    Omit<ApplicationExpectationOptions, "sessionId" | "requestId"> {
  sessionId?: string;
  requestId?: string;
  traceId?: string;
}

const MAX_TRACKED_APPLICATION_CONTRACT_SESSIONS = 1_000;
const responseCounts = new Map<string, number>();
const expectationManagers = new Map<string, ApplicationExpectationManager>();

function consumeResponseSlot(
  sessionId: string,
):
  | "accepted"
  | "response_session_cap_reached"
  | "session_tracking_limit_reached" {
  const count = responseCounts.get(sessionId);
  if (count !== undefined) {
    if (count >= MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION)
      return "response_session_cap_reached";
    responseCounts.set(sessionId, count + 1);
    return "accepted";
  }
  if (responseCounts.size >= MAX_TRACKED_APPLICATION_CONTRACT_SESSIONS)
    return "session_tracking_limit_reached";
  responseCounts.set(sessionId, 1);
  return "accepted";
}

function transportOptions(
  options: ApplicationTransportOptions,
): ApplicationTransportOptions {
  return {
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.authToken === undefined
      ? {}
      : { authToken: options.authToken }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onWarning === undefined
      ? {}
      : { onWarning: options.onWarning }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.retryDelayMs === undefined
      ? {}
      : { retryDelayMs: options.retryDelayMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}

function noSessionResponseResult(): SendApplicationResponseAssertionsResult {
  return {
    accepted: false,
    acceptedCount: 0,
    results: [],
    rejection: "correlation_invalid",
  };
}

/** Send one or more G1 facts while keeping response extraction in crumbtrail-core. */
export async function sendApplicationResponseAssertions(
  options: SendApplicationResponseAssertionsOptions,
): Promise<SendApplicationResponseAssertionsResult> {
  let response: unknown;
  let facts: readonly ApplicationResponseFactOptions[];
  let sessionId: string | undefined;
  let requestId: string | undefined;
  let traceId: string | undefined;
  let transport: ApplicationTransportOptions;
  try {
    response = options.response;
    facts = options.facts;
    const requestCorrelation = readRequestCorrelation();
    sessionId =
      options.sessionId ??
      requestCorrelation?.sessionId ??
      getProcessSessionId();
    requestId = options.requestId ?? requestCorrelation?.requestId;
    traceId = options.traceId;
    transport = transportOptions(options);
  } catch {
    return {
      accepted: false,
      acceptedCount: 0,
      results: [],
      rejection: "invalid_options",
    };
  }
  if (!sessionId) return noSessionResponseResult();

  const built = checkApplicationResponse(
    response,
    facts,
    Date.now(),
    { requestId, traceId },
    sessionId,
  );
  const results = await Promise.all(
    built.results.map(
      async (result): Promise<SendApplicationResponseFactResult> => {
        if (!result.accepted || result.event === undefined) return result;
        const admission = consumeResponseSlot(sessionId);
        if (admission !== "accepted")
          return { accepted: false, rejection: admission };
        const delivered = await sendBackendEvent({
          ...transport,
          event: result.event,
          sessionId,
        }).catch(() => false);
        return { ...result, delivered };
      },
    ),
  );
  const acceptedCount = results.filter((result) => result.accepted).length;
  return {
    accepted: acceptedCount > 0,
    acceptedCount,
    results,
    ...(built.rejection === undefined ? {} : { rejection: built.rejection }),
  };
}

export const sendResponseAssertions = sendApplicationResponseAssertions;
export const sendApplicationResponseFacts = sendApplicationResponseAssertions;

function managerForSession(
  sessionId: string,
): ApplicationExpectationManager | undefined {
  const existing = expectationManagers.get(sessionId);
  if (existing) return existing;
  if (expectationManagers.size >= MAX_TRACKED_APPLICATION_CONTRACT_SESSIONS)
    return undefined;
  const manager = createApplicationExpectationManager({
    sessionId,
    emit: () => {},
  });
  expectationManagers.set(sessionId, manager);
  return manager;
}

/** Begin a G2 declaration; the returned handle is local and never serialized. */
export function beginApplicationExpectation(
  options: BeginApplicationExpectationOptions,
): ApplicationExpectationResult {
  let sessionId: string | undefined;
  let requestId: string | undefined;
  let traceId: string | undefined;
  let declaration: ApplicationExpectationOptions;
  let transport: ApplicationTransportOptions;
  try {
    const requestCorrelation = readRequestCorrelation();
    sessionId =
      options.sessionId ??
      requestCorrelation?.sessionId ??
      getProcessSessionId();
    requestId = options.requestId ?? requestCorrelation?.requestId;
    traceId = options.traceId;
    declaration = {
      name: options.name,
      kind: options.kind,
      deadlineMs: options.deadlineMs,
      ...(requestId === undefined ? {} : { requestId }),
      ...(traceId === undefined ? {} : { traceId }),
    };
    transport = transportOptions(options);
  } catch {
    return { accepted: false, rejection: "invalid_options" };
  }
  if (!sessionId) return { accepted: false, rejection: "correlation_invalid" };
  const validDeclaration = buildApplicationExpectationMissedEvent(
    declaration,
    "deadline",
    0,
  );
  if (!validDeclaration.accepted)
    return {
      accepted: false,
      rejection:
        validDeclaration.rejection === "invalid_timestamp"
          ? "invalid_options"
          : validDeclaration.rejection,
    };
  const manager = managerForSession(sessionId);
  if (!manager)
    return { accepted: false, rejection: "session_tracking_limit_reached" };
  return manager.begin(declaration, (event) => {
    void sendBackendEvent({ ...transport, event, sessionId }).catch(() => {});
  });
}

export const expectSideEffect = beginApplicationExpectation;
export const expectApplicationEffect = beginApplicationExpectation;

/** Close one process-owned expectation session and emit its unsatisfied work. */
export function clearApplicationExpectationSession(sessionId: string): void {
  const manager = expectationManagers.get(sessionId);
  if (!manager) return;
  manager.stop();
  expectationManagers.delete(sessionId);
}

export function resetApplicationContractStateForTests(): void {
  for (const manager of expectationManagers.values()) manager.stop();
  expectationManagers.clear();
  responseCounts.clear();
}
