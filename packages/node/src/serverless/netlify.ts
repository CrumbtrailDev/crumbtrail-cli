import { runServerlessInvocation } from "crumbtrail-core/serverless";
import type {
  NetlifyAsyncHandler,
  NetlifyFunctionEvent,
  NetlifyHostHandler,
  NodeServerlessAdapterOptions,
} from "./types";
import { readResultStatusCode, rejectCallbackStyle } from "./types";

export function withCrumbtrailNetlify<
  TEvent extends NetlifyFunctionEvent = NetlifyFunctionEvent,
  TContext = object,
  TResult = unknown,
>(
  handler: NetlifyHostHandler<TEvent, TContext, TResult>,
  options: NodeServerlessAdapterOptions,
): NetlifyAsyncHandler<TEvent, TContext, TResult> {
  return async function crumbtrailNetlifyHandler(event, context) {
    const callbackSupplied = arguments.length > 2;
    return runServerlessInvocation(
      {
        transport: options.transport,
        headers: event.headers,
        method: event.httpMethod,
        route: event.path,
        metadata: options.metadata,
        now: options.now,
      },
      async (invocation) => {
        if (callbackSupplied) rejectCallbackStyle("Netlify");
        const result = await handler(event, context);
        invocation.setStatusCode(readResultStatusCode(result));
        return result;
      },
    );
  };
}
