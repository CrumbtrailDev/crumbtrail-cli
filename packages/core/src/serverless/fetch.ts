import {
  runServerlessInvocation,
  type ServerlessInvocationTransport,
} from "./invocation";

export type FetchWaitUntil = (promise: Promise<void>) => void;

export interface FetchServerlessAdapterOptions {
  transport: ServerlessInvocationTransport;
  waitUntil?: FetchWaitUntil;
  now?: () => number;
}

export type FetchHostHandler = (request: Request) => Response | Promise<Response>;
export type FetchAsyncHandler = (request: Request) => Promise<Response>;

export function withCrumbtrailFetch(
  handler: FetchHostHandler,
  options: FetchServerlessAdapterOptions,
): FetchAsyncHandler {
  return async function crumbtrailFetchHandler(request) {
    return runServerlessInvocation(
      {
        transport: transportWithScheduledFlush(options),
        headers: request.headers,
        method: request.method,
        route: readPathname(request.url),
        metadata: { requestAborted: request.signal.aborted },
        now: options.now,
      },
      async (context) => {
        const response = await handler(request);
        context.setStatusCode(response.status);
        return response;
      },
    );
  };
}

function transportWithScheduledFlush(
  options: FetchServerlessAdapterOptions,
): ServerlessInvocationTransport {
  if (!options.waitUntil) return options.transport;

  return {
    capture(event) {
      return options.transport.capture(event);
    },
    flush() {
      const containedFlush = Promise.resolve()
        .then(() => options.transport.flush?.())
        .then(
          () => undefined,
          () => undefined,
        );
      options.waitUntil?.(containedFlush);
    },
  };
}

function readPathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}
