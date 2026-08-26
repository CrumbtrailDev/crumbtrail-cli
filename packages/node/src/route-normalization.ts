/**
 * Normalizes a URL to the route identity used by session comparison.
 *
 * Query parameters are request data, not route identity. Numeric path segments
 * with at least two digits are treated as resource identifiers, matching the
 * existing comparison behavior.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://crumbtrail.local");
    return parsed.pathname
      .split("/")
      .map((segment) => (/^\d{2,}$/.test(segment) ? "<id>" : segment))
      .join("/");
  } catch {
    return url;
  }
}
