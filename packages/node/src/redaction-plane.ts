import {
  BACKEND_REDACTION_POLICY,
  mergeRedactionMetadata,
  withRedactionPolicy,
  type RedactionMetadata,
} from "crumbtrail-core";

/**
 * Stamp the plane on redaction metadata produced by server-side capture.
 *
 * The engine in `crumbtrail-core` is shared by both runtimes and has no way to
 * know which one called it, so every helper it exposes stamps the browser
 * policy id. Everything this package captures is a backend event: a response
 * body the handler sent, a job result, a cached value, a database row, a route
 * or an error string the server produced. Routing all of it through here is
 * what keeps a backend event from claiming a browser produced it.
 *
 * There is no browser-plane emitter in this package. If one ever appears it
 * must keep the browser tag and skip these helpers.
 */
export function backendRedactionMetadata(
  ...items: Array<RedactionMetadata | undefined>
): RedactionMetadata | undefined {
  return withRedactionPolicy(
    mergeRedactionMetadata(...items),
    BACKEND_REDACTION_POLICY,
  );
}

/** {@link backendRedactionMetadata}, written onto an event payload's `redaction` field. */
export function attachBackendRedactionMetadata(
  target: Record<string, unknown>,
  ...items: Array<RedactionMetadata | undefined>
): void {
  const metadata = backendRedactionMetadata(...items);
  if (metadata) target.redaction = metadata;
}
