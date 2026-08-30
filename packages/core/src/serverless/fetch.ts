import {
  runServerlessInvocation,
  type ServerlessDeliveryErrorContext,
  type ServerlessTransportConfig,
} from "./invocation";

export type FetchWaitUntil = (promise: Promise<void>) => void;

interface FetchServerlessAdapterCommonOptions {
  waitUntil?: FetchWaitUntil;
  metadata?: Readonly<Record<string, unknown>>;
  service?: string;
  onError?: (error: unknown, context: ServerlessDeliveryErrorContext) => void;
  now?: () => number;
}

export type FetchServerlessAdapterOptions =
  FetchServerlessAdapterCommonOptions & ServerlessTransportConfig;

export type FetchHostHandler = (
  request: Request,
) => Response | Promise<Response>;
export type FetchAsyncHandler = (request: Request) => Promise<Response>;

export function withCrumbtrailFetch(
  handler: FetchHostHandler,
  options: FetchServerlessAdapterOptions,
): FetchAsyncHandler {
  return async function crumbtrailFetchHandler(request) {
    const { waitUntil, ...invocationOptions } = options;
    return runServerlessInvocation(
      {
        ...invocationOptions,
        headers: request.headers,
        method: request.method,
        route: readPathname(request.url),
        metadata: {
          ...options.metadata,
          requestAborted: request.signal.aborted,
        },
        deferCleanup: waitUntil,
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

function readPathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}
