import { describe, expect, it } from "vitest";

import { NODE_CONTRACT_CAPABILITIES } from "../node-contract-capabilities";
import * as packageIndex from "../index";

/**
 * The marker tells the hosted cloud that this package implements a contract.
 * Asserting the marker's own literals only restates the marker, so it cannot
 * catch the failure that matters: the marker still reading true after the
 * implementation behind it changed shape. The cloud gates real code paths on
 * these keys and fails CLOSED when a key is absent.
 *
 * The map is now empty. Every capability it declared — `tenantContextFactory`,
 * `ticketComment`, `evidenceSourceFetchInjection` — described a third-party
 * integration surface that left with `evidence-sources/`, `ticket/`, and
 * `knowledge/`. The assertions below pin that emptiness, so re-adding a key
 * without re-adding an implementation fails here rather than in the cloud at
 * runtime.
 */
describe("NODE_CONTRACT_CAPABILITIES", () => {
  it("declares no capabilities, because the integration surfaces were removed", () => {
    expect(NODE_CONTRACT_CAPABILITIES).toEqual({});
  });

  it("no longer declares the three integration capabilities the cloud gated on", () => {
    for (const capability of [
      "tenantContextFactory",
      "ticketComment",
      "evidenceSourceFetchInjection",
    ]) {
      expect(capability in NODE_CONTRACT_CAPABILITIES).toBe(false);
    }
  });

  it("is re-exported from the package index", () => {
    // The cloud probes this package through a namespace import and reads the
    // marker off the index, so the re-export is the contract, not a detail.
    expect(packageIndex.NODE_CONTRACT_CAPABILITIES).toBe(
      NODE_CONTRACT_CAPABILITIES,
    );
  });
});
