/**
 * The two Crumbtrail font stacks, for surfaces that render outside a page the
 * design system styles.
 *
 * Everything in the dashboard and on the marketing site reads
 * `--ds-font-body` / `--ds-font-mono` from
 * `packages/design-system/src/styles/crumbtrail/tokens.css` in the main
 * product repository. Three surfaces in this repository cannot: the in page
 * widget mounts into a shadow root on a customer's own site, the Node server
 * serves a standalone HTML page, and the CLI's OAuth callback page is written
 * by the CLI itself. Each one used to name a different system stack, so the
 * first branded thing a customer saw was not the brand.
 *
 * These are copies of those tokens, face for face, asserted against them by
 * `packages/core/src/__tests__/brand-type.test.ts`. Roobert is not served to
 * customer pages, so in practice the widget renders Inter or the system face —
 * naming the ramp anyway costs nothing and means a licensed Roobert starts
 * working the moment it is served.
 */
export const BRAND_FONT_STACK =
  "Roobert, Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export const BRAND_MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";
