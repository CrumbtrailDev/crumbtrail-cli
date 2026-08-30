import { runServerlessInvocation } from "crumbtrail-core/serverless";
import type {
  NodeServerlessAdapterOptions,
  VercelNodeAsyncHandler,
  VercelNodeHostHandler,
  VercelNodeRequest,
  VercelNodeResponse,
} from "./types";
import { pathFromUrl, rejectCallbackStyle } from "./types";

export function withCrumbtrailVercel<
  TRequest extends VercelNodeRequest = VercelNodeRequest,
  TResponse extends VercelNodeResponse = VercelNodeResponse,
  TResult = unknown,
>(
  handler: VercelNodeHostHandler<TRequest, TResponse, TResult>,
  options: NodeServerlessAdapterOptions,
): VercelNodeAsyncHandler<TRequest, TResponse, TResult> {
  return async function crumbtrailVercelHandler(request, response) {
    const callbackSupplied = arguments.length > 2;
    return runServerlessInvocation(
      {
        transport: options.transport,
        headers: request.headers,
        method: request.method,
        route: pathFromUrl(request.url),
        metadata: options.metadata,
        now: options.now,
      },
      async (invocation) => {
        try {
          if (callbackSupplied) rejectCallbackStyle("Vercel");
          return await handler(request, response);
        } finally {
          invocation.setStatusCode(response.statusCode);
        }
      },
    );
  };
}
