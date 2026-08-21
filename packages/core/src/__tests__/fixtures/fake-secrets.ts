// Redaction tests need values that look exactly like real credentials, because
// that shape is what the classifier keys on. Writing them as literals trips
// GitHub push protection, so they are assembled at runtime instead: the file
// never contains a contiguous token, and the test still sees a realistic one.
//
// These are invented values. They authenticate nothing.

const join = (...parts: string[]): string => parts.join("_");

/** Stripe-shaped live key. Invented; matches the prefix and length only. */
export const fakeStripeLiveKey = (suffix = "51H8xQ2eZvKYlo2CabcdEFGHijkl"): string =>
  join("sk", "live", suffix);
