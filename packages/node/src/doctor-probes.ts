/** Session id prefixes reserved for Crumbtrail's own doctor probes. */
export const PROBE_SESSION_PREFIXES = [
  "ses_probe_",
  "ses_otlp_probe_",
] as const;

export function isDoctorProbeSessionId(sessionId: string): boolean {
  return PROBE_SESSION_PREFIXES.some((prefix) => sessionId.startsWith(prefix));
}
