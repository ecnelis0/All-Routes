import type { BikeLaneTier, CrashRecord, HighwaySegment, LatLng } from "../types";
import type { GraphEdge, RoadClass } from "../routing/graph";
import { distanceToPathMeters } from "../geo";
import { approxMeters } from "../routing/graph";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  type DangerousNeighborhood,
} from "../data/sfDangerousNeighborhoods";

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
  /**
   * 0-100 risk of the worst flagged neighbourhood this edge falls inside,
   * tapering to 0 at the area's edge (see `lib/data/sfDangerousNeighborhoods.ts`).
   *
   * Area-level risk, distinct from `crashDensity`'s point-level hotspots:
   * a street can have a clean crash record and still run through a district
   * a rider asked not to be routed through.
   */
  neighborhoodRisk: number;
  /** Edge length in km - mostly an exposure multiplier for the model. */
  lengthKm: number;
}

// v2 added `neighborhoodRisk`. Bumping this is what makes an artifact
// trained on v1 refuse to load rather than silently mis-map coefficients.
export const FEATURE_SET_VERSION = 2;

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
  "neighborhoodRisk",
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
/**
 * Grid index over highway geometry.
 *
 * Needed because the real exposure dataset is ~5,600 roads, not the 7
 * hand-drawn shapes this used to run on. Testing every road against every
 * one of ~211k directed edges is ~1.2 billion distance-to-polyline
 * computations; bucketing cuts it to the handful of roads actually near
 * each edge.
 */
export interface HighwayIndex {
  segments: HighwaySegment[];
  /** cell key -> indices into `segments` */
  buckets: Map<string, number[]>;
}

export interface FeatureContext {
  crashBuckets: Map<string, CrashRecord[]>;
  freeways: HighwayIndex;
  arterials: HighwayIndex;
  nodes: LatLng[];
  neighborhoods: DangerousNeighborhood[];
}

// Must be >= the largest influence radius below, so a single ring of
// neighbouring cells is guaranteed to cover everything in range.
const HIGHWAY_CELL_METERS = 500;

function cellKey(p: LatLng, cellMeters: number): string {
  const mPerLng = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  return `${Math.floor((p.lat * M_PER_DEG_LAT) / cellMeters)},${Math.floor(
    (p.lng * mPerLng) / cellMeters
  )}`;
}

function buildHighwayIndex(segments: HighwaySegment[]): HighwayIndex {
  const buckets = new Map<string, number[]>();
  segments.forEach((seg, i) => {
    // Register the road in every cell any of its vertices falls in. Long
    // roads therefore appear in many cells, which is exactly right - a
    // freeway is "near" everywhere along its length.
    const seen = new Set<string>();
    for (const pt of seg.path) {
      const k = cellKey(pt, HIGHWAY_CELL_METERS);
      if (seen.has(k)) continue;
      seen.add(k);
      const b = buckets.get(k);
      if (b) b.push(i);
      else buckets.set(k, [i]);
    }
  });
  return { segments, buckets };
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
  nodes: LatLng[],
  neighborhoods: DangerousNeighborhood[] = SF_DANGEROUS_NEIGHBORHOODS
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
    freeways: buildHighwayIndex(highways.filter((h) => h.type === "freeway")),
    arterials: buildHighwayIndex(highways.filter((h) => h.type === "arterial")),
    nodes,
    neighborhoods,
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

/**
 * Worst flagged-neighbourhood risk at a point.
 *
 * Risk is held flat across the inner 70% of each circle and tapered to
 * zero over the outer 30%, rather than peaking at the centre. A
 * distance-from-centre falloff would be wrong here: these circles
 * approximate districts, and nothing about a district makes its
 * geometric centre more dangerous than a block near its edge. The taper
 * exists only so the router does not see a cliff at the boundary, which
 * would make routes hug the perimeter in an obviously artificial way.
 */
function neighborhoodRiskAt(point: LatLng, areas: DangerousNeighborhood[]): number {
  let worst = 0;
  for (const a of areas) {
    const d = approxMeters(point, a.center);
    if (d >= a.radiusMeters) continue;
    const core = a.radiusMeters * 0.7;
    const risk = d <= core ? a.risk : a.risk * (1 - (d - core) / (a.radiusMeters - core));
    if (risk > worst) worst = risk;
  }
  return worst;
}

/**
 * Closeness to the nearest road in `index`, 0 (at/outside the influence
 * radius) to 1 (on top of it). Scaled by how fast the road typically runs,
 * so a 65mph freeway reads as more exposure than a 30mph arterial at the
 * same distance.
 */
function proximity(point: LatLng, index: HighwayIndex, influenceMeters: number): number {
  const mPerLng = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const row = Math.floor((point.lat * M_PER_DEG_LAT) / HIGHWAY_CELL_METERS);
  const col = Math.floor((point.lng * mPerLng) / HIGHWAY_CELL_METERS);

  const candidates = new Set<number>();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const b = index.buckets.get(`${row + dr},${col + dc}`);
      if (b) for (const i of b) candidates.add(i);
    }
  }

  let best = 0;
  for (const i of candidates) {
    const seg = index.segments[i];
    const d = distanceToPathMeters(point, seg.path);
    if (d >= influenceMeters) continue;
    const speedFactor = Math.min(1.3, (seg.typicalSpeedMph || 35) / 45);
    best = Math.max(best, (1 - d / influenceMeters) * speedFactor);
  }
  return Math.min(1, best);
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
    neighborhoodRisk: neighborhoodRiskAt(mid, ctx.neighborhoods),
    lengthKm: km,
  };
}
