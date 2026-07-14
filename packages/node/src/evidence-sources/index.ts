/**
 * Evidence-sources barrel + adapter registration.
 *
 * Importing this module is what populates {@link EVIDENCE_SOURCE_PROVIDERS} with
 * the built-in adapters (Sentry today; CloudWatch/Splunk/Datadog/PostHog/
 * Cloudflare in CP4–CP7 each add one `registerEvidenceProvider` line below).
 * Runtime consumers that call `evidenceSourcesFromEnv()` import from here (not
 * from `./registry` directly) so the registry is guaranteed populated first.
 *
 * `registry.ts` stays adapter-free on purpose: it is the pure contract, so unit
 * tests can assert an empty registry and exercise the framework against the test
 * double without pulling any provider in.
 */
import { registerEvidenceProvider } from "./registry";
import { sentryEvidenceProvider } from "./sentry";
import { cloudWatchEvidenceProvider } from "./cloudwatch";
import { splunkEvidenceProvider } from "./splunk";
import { datadogEvidenceProvider } from "./datadog";
import { posthogEvidenceProvider } from "./posthog";
import { cloudflareEvidenceProvider } from "./cloudflare";

registerEvidenceProvider(sentryEvidenceProvider);
registerEvidenceProvider(cloudWatchEvidenceProvider);
registerEvidenceProvider(splunkEvidenceProvider);
registerEvidenceProvider(datadogEvidenceProvider);
registerEvidenceProvider(posthogEvidenceProvider);
registerEvidenceProvider(cloudflareEvidenceProvider);

export * from "./registry";
export * from "./fetch-all";
export * from "./redact";
export * from "./sentry";
export * from "./cloudwatch";
export * from "./sigv4";
export * from "./splunk";
export * from "./datadog";
export * from "./posthog";
export * from "./cloudflare";
