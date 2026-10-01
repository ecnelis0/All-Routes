import type { BikeLaneTier, CrashRecord, HighwaySegment, LatLng } from "../types";
import type { GraphEdge, RoadClass } from "../routing/graph";
import { distanceToPathMeters } from "../geo";
import { approxMeters } from "../routing/graph";

/**
 * THE FEATURE CONTRACT.
 *
 * One row of model input: everything known about a single street edge that
 * could plausibly bear on how dangerous it is to ride. This type is the
 * single shared contract between three things that must agree exactly or
 * the model silently scores garbage:
 *
 *   1. `extractFeatures` below, which builds rows at runtime
 *   2. `ml/export_training_data.py`, which builds the same rows for training
 *   3. the trained model itself, whose coefficients are positional
 *
 * `FEATURE_ORDER` at the bottom pins the ordering, and the exported model
 * artifact records which feature names it was trained on so a mismatch
 * fails loudly at load time instead of producing plausible-looking nonsense.
 *
 * ADDING A FEATURE: add the field here, extract it below, add it to
 * `FEATURE_ORDER`, bump `FEATURE_SET_VERSION`, re-export training data and
 * retrain. The version bump is what makes a stale artifact refuse to load.
 */
export interface EdgeFeatures {
  /**
   * Weighted crash incidents within a fixed radius of the edge midpoint.
   *
   * A COUNT over a fixed-area disc, deliberately NOT divided by edge
   * length. The crashes counted come from a constant 150m search radius,
   * so the area sampled is the same whether the edge is 10m or 200m long;
   * dividing by length would make an 11m edge beside one serious crash
   * report ~40x the density of a 400m edge beside the same crash, purely
   * because of how OSM happened to split the street.
   */
  crashDensity: number;
  /** Same, counting only severe (injury/fatal) incidents. */
  severeCrashDensity: number;
  /** 0 = fully protected lane, 1 = no cycling infrastructure at all. */
  laneProtection: number;
  /** 1 when this edge *is* dedicated cycling infrastructure. */
  isCycleway: number;
  /** 0-1, how close this edge runs to a freeway (1 = adjacent). */
  freewayProximity: number;
  /** 0-1, same for large arterials. */
  arterialProximity: number;
  /** Posted speed in mph, normalized by 45; 0 when OSM doesn't know. */
  speedNormalized: number;
  /** 0-1 road-class severity: residential ~0.1, primary ~1.0. */
  roadClassRisk: number;
  /** Edge length in km - mostly an exposure multiplier for the model. */
  lengthKm: number;
}

export const FEATURE_SET_VERSION = 1;

/**
 * Positional order for the feature vector handed to a linear/tree model.
 * Changing this order without bumping `FEATURE_SET_VERSION` will mis-map
 * every coefficient, so don't.
 */
export const FEATURE_ORDER: (keyof EdgeFeatures)[] = [
  "crashDensity",
  "severeCrashDensity",
  "laneProtection",
  "isCycleway",
  "freewayProximity",
  "arterialProximity",
  "speedNormalized",
  "roadClassRisk",
  "lengthKm",
];

export function featuresToVector(f: EdgeFeatures): number[] {
  return FEATURE_ORDER.map((k) => f[k]);
}

// --- Feature encodings -----------------------------------------------------
// These are *encodings*, not safety judgements: they turn categorical street
// facts into numbers on a consistent scale. How much each one matters is
// exactly what training decides, so nothing here should be tuned by hand to
// make routes look better - tune the model, not the features.

const LANE_PROTECTION: Record<BikeLaneTier, number> = {
  fullyProtected: 0,
  semiProtected: 0.35,
  unprotected: 0.7,
  none: 1,
};

const ROAD_CLASS_RISK: Record<RoadClass, number> = {
  cycleway: 0,
  path: 0.05,
  livingStreet: 0.1,
  residential: 0.2,
  service: 0.25,
  tertiary: 0.5,
  secondary: 0.75,
  primary: 1,
};

const CRASH_SEARCH_RADIUS_METERS = 150;
const SEVERITY_WEIGHT: Record<number, number> = { 1: 1, 2: 2.5, 3: 5 };
const TYPE_WEIGHT: Record<string, number> = {
  collision: 1,
  nearmiss: 0.5,
  hazard: 0.4,
  theft: 0.15,
};

const FREEWAY_INFLUENCE_METERS = 500;
const ARTERIAL_INFLUENCE_METERS = 250;

/**
 * Pre-indexed context shared across every edge in one extraction pass.
 * Built once by `buildFeatureContext` - computing crash proximity by
 * scanning all crashes for each of ~240k directed edges would be ~10^8
 * distance checks, so crashes go into a grid first.
 */
export interface FeatureContext {
  crashBuckets: Map<string, CrashRecord[]>;
  freeways: HighwaySegment[];
  arterials: HighwaySegment[];
  nodes: LatLng[];
}

const CRASH_BUCKET_METERS = 200;
const M_PER_DEG_LAT = 111_320;

function crashBucketKey(p: LatLng): string {
  const mPerLng = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  return `${Math.floor((p.lat * M_PER_DEG_LAT) / CRASH_BUCKET_METERS)},${Math.floor(
    (p.lng * mPerLng) / CRASH_BUCKET_METERS
  )}`;
}

export function buildFeatureContext(
  crashes: CrashRecord[],
  highways: HighwaySegment[],
  nodes: LatLng[]
): FeatureContext {
  const crashBuckets = new Map<string, CrashRecord[]>();
  for (const c of crashes) {
    const k = crashBucketKey(c.position);
    const b = crashBuckets.get(k);
    if (b) b.push(c);
    else crashBuckets.set(k, [c]);
  }
  return {
    crashBuckets,
    freeways: highways.filter((h) => h.type === "freeway"),
    arterials: highways.filter((h) => h.type === "arterial"),
    nodes,
  };
}

function nearbyCrashes(ctx: FeatureContext, p: LatLng): CrashRecord[] {
  const mPerLng = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const row = Math.floor((p.lat * M_PER_DEG_LAT) / CRASH_BUCKET_METERS);
  const col = Math.floor((p.lng * mPerLng) / CRASH_BUCKET_METERS);
  const out: CrashRecord[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const b = ctx.crashBuckets.get(`${row + dr},${col + dc}`);
      if (b) out.push(...b);
    }
  }
  return out;
}

function proximity(point: LatLng, segments: HighwaySegment[], influenceMeters: number): number {
  let best = 0;
  for (const s of segments) {
    const d = distanceToPathMeters(point, s.path);
    if (d >= influenceMeters) continue;
    best = Math.max(best, 1 - d / influenceMeters);
  }
  return best;
}

/**
 * Builds the feature row for one edge. Sampled at the edge's midpoint:
 * graph edges are single blocks (SF blocks are ~100m), so a midpoint is a
 * fair representative and costs a third of what sampling both endpoints
 * plus the middle would.
 */
export function extractFeatures(edge: GraphEdge, ctx: FeatureContext): EdgeFeatures {
  const a = ctx.nodes[edge.from];
  const b = ctx.nodes[edge.to];
  const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };

  let crashWeighted = 0;
  let severeWeighted = 0;
  for (const c of nearbyCrashes(ctx, mid)) {
    if (approxMeters(mid, c.position) > CRASH_SEARCH_RADIUS_METERS) continue;
    const w = (SEVERITY_WEIGHT[c.severity] ?? 1) * (TYPE_WEIGHT[c.type] ?? 0.5);
    crashWeighted += w;
    if (c.severity >= 2) severeWeighted += w;
  }

  const km = edge.lengthMeters / 1000;

  return {
    crashDensity: crashWeighted,
    severeCrashDensity: severeWeighted,
    laneProtection: LANE_PROTECTION[edge.tier],
    isCycleway: edge.roadClass === "cycleway" ? 1 : 0,
    freewayProximity: proximity(mid, ctx.freeways, FREEWAY_INFLUENCE_METERS),
    arterialProximity: proximity(mid, ctx.arterials, ARTERIAL_INFLUENCE_METERS),
    speedNormalized: edge.maxspeed ? Math.min(2, edge.maxspeed / 45) : 0,
    roadClassRisk: ROAD_CLASS_RISK[edge.roadClass],
    lengthKm: km,
  };
}
