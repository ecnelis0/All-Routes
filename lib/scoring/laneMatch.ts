import type { BikeLaneSegment, BikeLaneTier, LatLng } from "../types";
import type { GraphEdge } from "../routing/graph";
import { distanceToPathMeters } from "../geo";

/**
 * Reconciles the routing graph's bike-lane tiers against SFMTA's official
 * bikeway network.
 *
 * WHY THIS EXISTS. Graph tiers are inferred from OpenStreetMap cycleway
 * tags, which are crowd-maintained and inconsistent. SFMTA's dataset is
 * the city's own survey, classified by its own engineers
 * (CLASS I/IV = protected, CLASS II + buffer = semi-protected, CLASS II =
 * painted, CLASS III = sharrow), and it is the thing a rider would be
 * right to trust.
 *
 * They disagree far more than you would hope. Measured over the 57,542
 * graph edges that match an SFMTA facility within 20m, the two agreed on
 * only 44% of tiers, and the single largest category of disagreement was
 * 11,148 edges where OSM recorded no cycling infrastructure at all on a
 * street SFMTA classifies as fully protected. Left alone, the router was
 * blind to a large share of exactly the infrastructure this app exists to
 * route people onto.
 *
 * So: where SFMTA has coverage, SFMTA wins. Where it does not (the graph
 * extends slightly beyond the surveyed network, and includes paths and
 * service roads SFMTA does not catalogue), the OSM tag stands.
 */

const MATCH_TOLERANCE_METERS = 20;
const CELL_METERS = 100;
const M_PER_DEG_LAT = 111_320;

const TIER_RANK: Record<BikeLaneTier, number> = {
  none: 0,
  unprotected: 1,
  semiProtected: 2,
  fullyProtected: 3,
};
const BY_RANK: BikeLaneTier[] = ["none", "unprotected", "semiProtected", "fullyProtected"];

function cellKey(lat: number, lng: number): string {
  const mPerLng = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return `${Math.floor((lat * M_PER_DEG_LAT) / CELL_METERS)},${Math.floor(
    (lng * mPerLng) / CELL_METERS
  )}`;
}

export interface LaneMatchStats {
  edgesConsidered: number;
  matched: number;
  changed: number;
  /** Edges upgraded to fully/semi-protected that OSM had as none/unprotected. */
  upgradedToProtected: number;
}

/**
 * Rewrites `edge.tier` in place from the SFMTA network where a facility
 * lies within `MATCH_TOLERANCE_METERS` of the edge midpoint.
 *
 * Mutates rather than copying: the graph is ~211k edges built once per
 * process, and cloning it to change one field per edge is pure waste.
 * Called exactly once, from `getRoutingEngine`, before any scoring.
 *
 * Where several facilities are in range (opposite sides of a street,
 * overlapping records), the most protective wins. That is the optimistic
 * reading, but it matches how the records are actually laid out: a
 * protected lane on one side is usually recorded separately from the
 * painted lane opposite, and a rider can use either.
 */
export function applySfmtaLaneTiers(
  edges: GraphEdge[],
  nodes: LatLng[],
  lanes: BikeLaneSegment[]
): LaneMatchStats {
  const buckets = new Map<string, number[]>();
  lanes.forEach((lane, i) => {
    const seen = new Set<string>();
    for (const p of lane.path) {
      const k = cellKey(p.lat, p.lng);
      if (seen.has(k)) continue;
      seen.add(k);
      const b = buckets.get(k);
      if (b) b.push(i);
      else buckets.set(k, [i]);
    }
  });

  const stats: LaneMatchStats = {
    edgesConsidered: edges.length,
    matched: 0,
    changed: 0,
    upgradedToProtected: 0,
  };

  for (const edge of edges) {
    const a = nodes[edge.from];
    const b = nodes[edge.to];
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };

    const mPerLng = M_PER_DEG_LAT * Math.cos((mid.lat * Math.PI) / 180);
    const row = Math.floor((mid.lat * M_PER_DEG_LAT) / CELL_METERS);
    const col = Math.floor((mid.lng * mPerLng) / CELL_METERS);

    const candidates = new Set<number>();
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const bk = buckets.get(`${row + dr},${col + dc}`);
        if (bk) for (const i of bk) candidates.add(i);
      }
    }
    if (candidates.size === 0) continue;

    let bestRank = -1;
    for (const i of candidates) {
      const lane = lanes[i];
      const rank = TIER_RANK[lane.tier];
      // Skip the distance test when it cannot improve on what we have.
      if (rank <= bestRank) continue;
      if (distanceToPathMeters(mid, lane.path) <= MATCH_TOLERANCE_METERS) bestRank = rank;
    }
    if (bestRank < 0) continue;

    stats.matched++;
    const next = BY_RANK[bestRank];
    if (next !== edge.tier) {
      const wasUnprotected = TIER_RANK[edge.tier] <= 1;
      if (wasUnprotected && bestRank >= 2) stats.upgradedToProtected++;
      edge.tier = next;
      stats.changed++;
    }
  }

  return stats;
}
