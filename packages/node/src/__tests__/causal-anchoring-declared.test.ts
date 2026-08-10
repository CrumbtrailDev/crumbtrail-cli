// Every emitted detector has a DECIDED causal anchoring, or the build fails.
//
// The defect this closes is not any one unmapped detector. It is that
// `nodeKindsForDetector` ended in a silent empty default, so a detector that
// could not be placed produced `causalRole: "isolated"` — indistinguishable from
// a detector genuinely unrelated to the incident — and `causal_chain` went null
// with no way to tell the two apart. Four detectors were added to that table one
// at a time, each comment recording that it was the same failure paid for again.
//
// So this file does not assert that the mapping is COMPLETE. It asserts that
// every gap in it is a decision somebody made, and that the number of undecided
// ones can only go down.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DETECTOR_ANCHORING_DECLARED,
  DETECTOR_ANCHORING_UNREVIEWED,
} from "../causal-graph";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/**
 * The detectors the SDK can actually emit, read from the source that emits them.
 *
 * Extraction, not a maintained list: a second hand-kept list of detector names
 * would drift from the first and this test would grade the drift instead of the
 * product. The floor below is what makes the extraction safe to trust.
 */
function emittedDetectors(): string[] {
  const source = fs.readFileSync(path.join(SRC, "evidence-index.ts"), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/detector:\s*"([a-z0-9_]+)"/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Anchorings expressed as rules rather than as names, mirrored from
 * `nodeKindsForDetector`. Read from the source for the same reason as above: a
 * restated copy would let the two drift apart silently.
 */
function ruleCoveredDetectors(): { prefixes: string[]; explicit: Set<string> } {
  const source = fs.readFileSync(path.join(SRC, "causal-graph.ts"), "utf8");
  const start = source.indexOf("function nodeKindsForDetector");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}\n", start));

  const prefixes = [...body.matchAll(/startsWith\("([a-z_]+)"\)/g)].map((m) => m[1]);
  const explicit = new Set([...body.matchAll(/case "([a-z0-9_]+)"/g)].map((m) => m[1]));

  const dbBlock = source.match(/DB_WRITE_DETECTORS = new Set\(\[([\s\S]*?)\]\)/);
  expect(dbBlock).not.toBeNull();
  for (const m of dbBlock![1].matchAll(/"([a-z0-9_]+)"/g)) explicit.add(m[1]);

  return { prefixes, explicit };
}

/**
 * The exact undecided set at the moment this ratchet was installed.
 *
 * Frozen by NAME, not by count, and that distinction is the whole ratchet. A
 * count only catches net growth: review one detector and add a new unreviewed
 * one and the number is unchanged, which is precisely the case worth catching —
 * a new detector arriving with nobody having looked at it.
 *
 * Entries may LEAVE this list, by being mapped or declared with a reason. Nothing
 * may join it.
 */
const UNREVIEWED_AT_INSTALL: ReadonlySet<string> = new Set([
  "accepted_text_was_truncated",
  "acknowledged_batch_rows_missing",
  "acknowledged_state_contradicted_by_read",
  "acknowledged_write_lost",
  "acknowledged_write_never_landed",
  "api_route_returned_document",
  "batch_applied_count_exceeds_staged_rows",
  "batch_value_shift",
  "blocked_script_prevented_action",
  "cached_empty_result_after_data_arrived",
  "cart_lost_after_session_expiry",
  "cart_remerged_on_login",
  "casefold_duplicate_identity_accepted",
  "checkout_committed_after_pricing_timeout",
  "concurrent_duplicate_mutation",
  "content_type_body_mismatch",
  "counter_contradiction",
  "country_postal_validation_mismatch",
  "cross_user_read",
  "currency_locale_mismatch",
  "db_delta_mismatch",
  "declined_payment_ordered",
  "derived_count_below_observed_inserts",
  "display_date_timezone_mismatch",
  "download_empty_body",
  "downstream_succeeded_after_timeout",
  "duplicate_charge",
  "duplicate_readback",
  "duplicate_restock",
  "existing_children_reparented_to_new_row",
  "filter_contradiction",
  "form_reset_after_error",
  "fractional_cent_rounding",
  "ineffective_input",
  "ineffective_submit",
  "inflight_request_invalidated_by_session_rotation",
  "input_reverted",
  "interpolation_artifact",
  "invalid_webhook_signature_accepted",
  "job_drain_left_work_deferred",
  "latency_outlier",
  "layout_overflow",
  "listener_growth",
  "locale_decimal_scale_shift",
  "lost_update",
  "money_scale_shift",
  "mutations_missing_entity_audit",
  "n_plus_one_query",
  "notification_lifecycle_order_inverted",
  "order_committed_with_negative_inventory",
  "orphaned_reference",
  "pagination_first_page_offset",
  "pricing_total_ignored_by_checkout",
  "refund_total_exceeded",
  "report_total_contradicts_source_row",
  "request_reconnect_storm",
  "request_target_row_mismatch",
  "response_exceeded_requested_limit",
  "response_race",
  "result_row_loss",
  "retry_schedule_clock_shift",
  "rtl_physical_layout_rules",
  "runtime_warning",
  "same_request_row_rewritten",
  "shared_state_bleed",
  "stale_client_build",
  "stale_value_writeback",
  "stale_view_after_pop",
  "state_flip_flop",
  "stored_active_markup",
  "stream_desync",
  "ui_api_divergence",
  "ui_arithmetic_mismatch",
]);

describe("causal anchoring is declared, never defaulted", () => {
  it("extracts a plausible number of detectors, or says so instead of passing", () => {
    // The load-bearing control. If `evidence-index.ts` stops writing
    // `detector: "..."` literally, the extraction returns a handful of names,
    // every other assertion here passes vacuously, and this file becomes a green
    // check over nothing.
    expect(emittedDetectors().length).toBeGreaterThanOrEqual(90);
  });

  it("gives every emitted detector a mapping, a prefix rule, or a written decision", () => {
    const { prefixes, explicit } = ruleCoveredDetectors();
    const undecided = emittedDetectors().filter(
      (detector) =>
        !explicit.has(detector) &&
        !prefixes.some((prefix) => detector.startsWith(prefix)) &&
        !DETECTOR_ANCHORING_DECLARED.has(detector) &&
        !DETECTOR_ANCHORING_UNREVIEWED.has(detector),
    );
    expect(
      undecided,
      `these detectors fall through to the empty default with no decision recorded: ${undecided.join(", ")}. Map them in nodeKindsForDetector, or declare them in DETECTOR_ANCHORING_DECLARED with the reason they have no node.`,
    ).toEqual([]);
  });

  it("never lets a NEW detector join the undecided set", () => {
    const joined = [...DETECTOR_ANCHORING_UNREVIEWED].filter(
      (detector) => !UNREVIEWED_AT_INSTALL.has(detector),
    );
    expect(
      joined,
      `these detectors were added to the undecided set after the ratchet was installed: ${joined.join(", ")}. Decide their anchoring instead — map them, or declare them with a reason.`,
    ).toEqual([]);
  });

  it("lets a reviewed detector leave the undecided set", () => {
    // The ratchet must turn one way only. A test pinning the set to EQUAL its
    // install-time contents would make reviewing a detector a test failure,
    // which is the opposite of the incentive this file exists to create.
    expect(DETECTOR_ANCHORING_UNREVIEWED.size).toBeLessThanOrEqual(UNREVIEWED_AT_INSTALL.size);
  });

  it("keeps the two lists disjoint", () => {
    // A detector in both is a decision recorded twice with two different answers.
    const both = [...DETECTOR_ANCHORING_DECLARED.keys()].filter((d) =>
      DETECTOR_ANCHORING_UNREVIEWED.has(d),
    );
    expect(both).toEqual([]);
  });

  it("requires a real reason on every reviewed declaration", () => {
    // "n/a" is not a decision. A reason short enough to be a placeholder is one.
    for (const [detector, reason] of DETECTOR_ANCHORING_DECLARED) {
      expect(reason.length, `${detector} needs a reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it("does not declare a detector the SDK never emits", () => {
    // A stale entry is worse than a missing one: it reads as coverage.
    const emitted = new Set(emittedDetectors());
    const ghosts = [
      ...DETECTOR_ANCHORING_DECLARED.keys(),
      ...DETECTOR_ANCHORING_UNREVIEWED,
    ].filter((detector) => !emitted.has(detector));
    expect(ghosts).toEqual([]);
  });
});
