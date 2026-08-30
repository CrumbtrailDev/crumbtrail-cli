import { runServerlessInvocation } from "crumbtrail-core/serverless";
import type {
  AwsLambdaAsyncHandler,
  AwsLambdaHostHandler,
  AwsLambdaHttpEvent,
  NodeServerlessAdapterOptions,
} from "./types";
import { readResultStatusCode, rejectCallbackStyle } from "./types";

export function withCrumbtrailAwsLambda<
  TEvent extends AwsLambdaHttpEvent = AwsLambdaHttpEvent,
  TContext = object,
  TResult = unknown,
>(
  handler: AwsLambdaHostHandler<TEvent, TContext, TResult>,
  options: NodeServerlessAdapterOptions,
): AwsLambdaAsyncHandler<TEvent, TContext, TResult> {
  return async function crumbtrailAwsLambdaHandler(event, context) {
    const callbackSupplied = arguments.length > 2;
    const request = normalizeAwsHttpEvent(event);

    return runServerlessInvocation(
      {
        transport: options.transport,
        headers: event.headers,
        method: request.method,
        route: request.route,
        metadata: options.metadata,
        now: options.now,
      },
      async (invocation) => {
        if (callbackSupplied) rejectCallbackStyle("AWS Lambda");
        if (!request.method || !request.route) {
          throw new TypeError(
            "withCrumbtrailAwsLambda requires an API Gateway compatible HTTP event",
          );
        }
        const result = await handler(event, context);
        invocation.setStatusCode(readResultStatusCode(result));
        return result;
      },
    );
  };
}

function normalizeAwsHttpEvent(event: AwsLambdaHttpEvent): {
  method?: string;
  route?: string;
} {
  const method = firstString(
    "httpMethod" in event ? event.httpMethod : undefined,
    event.requestContext?.http?.method,
    "method" in event ? event.method : undefined,
  );
  const route = firstString(
    event.resource,
    routeFromRouteKey(event.routeKey),
    event.requestContext?.resourcePath,
    routeFromRouteKey(event.requestContext?.routeKey),
    event.rawPath,
    event.requestContext?.http?.path,
    event.path,
  );
  return { method, route };
}

function routeFromRouteKey(routeKey: string | undefined): string | undefined {
  if (!routeKey || routeKey === "$default") return undefined;
  const separator = routeKey.indexOf(" ");
  return separator >= 0 ? routeKey.slice(separator + 1) : routeKey;
}

function firstString(...values: readonly unknown[]): string | undefined {
  const value = values.find(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  return typeof value === "string" ? value : undefined;
}
