import type { HighwaySegment } from "../types";
import data from "../data/sfHighways.json";

/**
 * Real freeway and arterial geometry for San Francisco, from OpenStreetMap
 * via `scripts/fetchSfBikeGraph.mjs` (ODbL).
 *
 * Replaces `MOCK_HIGHWAY_SEGMENTS`, which was seven hand-drawn shapes of
 * 3-6 points each. That meant ~170 of San Francisco's real arterials -
 * Bayshore, James Lick, Junipero Serra, Octavia, Bryant, 19th Avenue and
 * the rest - contributed exactly zero highway-exposure risk to the model.
 * A route could run a mile alongside the Central Freeway and score as
 * though it were on a quiet residential street.
 *
 * Note these roads are deliberately NOT in the routable graph: bikes are
 * banned from the freeways, and the graph excludes them. They matter here
 * purely as a proximity hazard - the thing you ride *next to*, not on.
 */
interface HighwayFile {
  generatedAt: string;
  source: string;
  segments: HighwaySegment[];
}

const file = data as HighwayFile;

export const REAL_SF_HIGHWAYS: HighwaySegment[] = file.segments;
export const SF_HIGHWAYS_GENERATED_AT = file.generatedAt;
