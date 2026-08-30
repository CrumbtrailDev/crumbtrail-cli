import type {
  ServerlessInvocationHeaders,
  ServerlessInvocationTransport,
} from "crumbtrail-core/serverless";

export interface NodeServerlessAdapterOptions {
  transport: ServerlessInvocationTransport;
  metadata?: Readonly<Record<string, unknown>>;
  now?: () => number;
}

export interface AwsLambdaHttpEventBase {
  headers?: ServerlessInvocationHeaders;
  path?: string;
  rawPath?: string;
  resource?: string;
  routeKey?: string;
  version?: string;
}

export interface AwsApiGatewayV1Event extends AwsLambdaHttpEventBase {
  httpMethod: string;
  path: string;
  requestContext?: AwsLambdaRequestContext;
}

export interface AwsApiGatewayV2Event extends AwsLambdaHttpEventBase {
  requestContext: AwsLambdaRequestContext & {
    http: {
      method: string;
      path: string;
    };
  };
}

export interface AwsCompatibleHttpEvent extends AwsLambdaHttpEventBase {
  method: string;
  path: string;
  requestContext?: AwsLambdaRequestContext;
}

export type AwsLambdaHttpEvent =
  AwsApiGatewayV1Event | AwsApiGatewayV2Event | AwsCompatibleHttpEvent;

export interface AwsLambdaRequestContext {
  http?: {
    method?: string;
    path?: string;
  };
  resourcePath?: string;
  routeKey?: string;
}

export type AwsLambdaContext = object;

export type AwsLambdaAsyncHandler<
  TEvent extends AwsLambdaHttpEvent = AwsLambdaHttpEvent,
  TContext = AwsLambdaContext,
  TResult = unknown,
> = (event: TEvent, context: TContext) => Promise<TResult>;

export type AwsLambdaHostHandler<
  TEvent extends AwsLambdaHttpEvent = AwsLambdaHttpEvent,
  TContext = AwsLambdaContext,
  TResult = unknown,
> = (event: TEvent, context: TContext) => TResult | Promise<TResult>;

export interface VercelNodeRequest {
  method?: string;
  url?: string;
  headers?: ServerlessInvocationHeaders;
}

export interface VercelNodeResponse {
  statusCode: number;
}

export type VercelNodeAsyncHandler<
  TRequest extends VercelNodeRequest = VercelNodeRequest,
  TResponse extends VercelNodeResponse = VercelNodeResponse,
  TResult = unknown,
> = (request: TRequest, response: TResponse) => Promise<TResult>;

export type VercelNodeHostHandler<
  TRequest extends VercelNodeRequest = VercelNodeRequest,
  TResponse extends VercelNodeResponse = VercelNodeResponse,
  TResult = unknown,
> = (request: TRequest, response: TResponse) => TResult | Promise<TResult>;

export interface NetlifyFunctionEvent {
  httpMethod: string;
  path: string;
  headers?: ServerlessInvocationHeaders;
}

export type NetlifyFunctionContext = object;

export type NetlifyAsyncHandler<
  TEvent extends NetlifyFunctionEvent = NetlifyFunctionEvent,
  TContext = NetlifyFunctionContext,
  TResult = unknown,
> = (event: TEvent, context: TContext) => Promise<TResult>;

export type NetlifyHostHandler<
  TEvent extends NetlifyFunctionEvent = NetlifyFunctionEvent,
  TContext = NetlifyFunctionContext,
  TResult = unknown,
> = (event: TEvent, context: TContext) => TResult | Promise<TResult>;

export function readResultStatusCode(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const statusCode = (result as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

export function pathFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split(/[?#]/, 1)[0];
  return path || undefined;
}

export function rejectCallbackStyle(platform: string): never {
  throw new TypeError(
    `${platform} callback style handlers are not supported; return a value or Promise instead`,
  );
}
