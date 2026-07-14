import type { EvidenceItem, EvidenceLane, EvidenceRef } from "crumbtrail-core";
import type { Divergence } from "./types";

// Divergence.plane is a strict subset of EvidenceLane, so the plane string
// doubles as the lane directly.
const PLANE_LANES: Record<Divergence["plane"], EvidenceLane> = {
  flow: "flow",
  network: "network",
  db: "db",
  env: "env",
};

function refFor(divergence: Divergence): EvidenceRef {
  const ref: EvidenceRef = {};
  if (divergence.requestId !== undefined) ref.requestId = divergence.requestId;
  if (divergence.table !== undefined) ref.table = divergence.table;
  if (divergence.pk !== undefined) ref.pk = divergence.pk;
  if (divergence.sig !== undefined) ref.sig = divergence.sig;
  return ref;
}

/**
 * Discriminator used to build a human-readable hint within the id. The diff
 * engine buckets by these (flow uses sig, network by anchorSig+requestId, db
 * by table+pk), but they are NOT guaranteed unique per divergence — e.g. two
 * db.row-value divergences on the same table (different pk) share the same
 * `table` discriminator. Falls back to the array index when a divergence
 * carries none (e.g. env). Uniqueness is guaranteed separately by appending
 * the array index as a suffix in divergenceToEvidence.
 */
function discriminatorFor(divergence: Divergence, index: number): string {
  return (
    divergence.sig ?? divergence.requestId ?? divergence.table ?? String(index)
  );
}

export function divergenceToEvidence(
  divergence: Divergence,
  index: number,
): EvidenceItem {
  return {
    id: `${divergence.plane}:${divergence.kind}:${discriminatorFor(divergence, index)}#${index}`,
    lane: PLANE_LANES[divergence.plane],
    kind: divergence.kind,
    brief: divergence.brief,
    ref: refFor(divergence),
    before: divergence.before,
    after: divergence.after,
  };
}

export function divergencesToEvidence(
  divergences: Divergence[],
): EvidenceItem[] {
  return divergences.map((divergence, index) =>
    divergenceToEvidence(divergence, index),
  );
}
