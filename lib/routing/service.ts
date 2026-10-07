import { readFileSync } from "node:fs";
import path from "node:path";

import type { BikeLaneTier, LatLng } from "../types";
import { REAL_SF_BIKE_CRASHES } from "../dataSources/sfBikeCrashes";
import { REAL_SF_HIGHWAYS } from "../dataSources/sfHighways";
import { REAL_SF_BIKE_LANES } from "../dataSources/sfmtaBikeLanes";
import { applySfmtaLaneTiers, type LaneMatchStats } from "../scoring/laneMatch";
import { buildFeatureContext, extractFeatures } from "../scoring/features";
import { createBaselineModel, PrecomputedScoreModel, type SafetyModel } from "../scoring/model";
import { loadModelArtifact } from "../scoring/artifact";
import { decodeGraph, NodeSpatialIndex, type BikeGraph, type GraphEdge } from "./graph";
import { findRoute, type RoutePath } from "./astar";
import { ROUTE_PROFILES, type RouteProfile } from "./cost";
import rawGraph from "../data/sfBikeGraph.json";
import rawElevation from "../data/sfNodeElevation.json";
import rawSignals from "../data/sfTrafficSignals.json";
import {
  SEVERITY_MULTIPLIER,
  SF_STEEP_AREAS,
  SF_STEEP_STREETS,
  STEEP_GRADE_THRESHOLD,
  type SteepArea,
  type SteepSeverity,
} from "../data/sfSteepAreas";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  type DangerousNeighborhood,
} from "../data/sfDangerousNeighborhoods";

/**
 * Process-wide, lazily-built routing state.
 *
 * Decoding a 120k-edge graph and scoring every edge takes on the order of a
 * second. Doing that per request would make the API unusable, so it happens
 * once and is cached for the life of the server process. Everything here is
 * immutable after construction, so sharing it across concurrent requests is
 * safe.
 */
export interface RoutingEngine {
  graph: BikeGraph;
  index: NodeSpatialIndex;
  /** Danger score per directed edge id, 0-100. */
  scores: Float32Array;
  model: SafetyModel;
  /** Edges leaving each node - a node with none can never be departed. */
  outDegree: Uint16Array;
  /** Edges arriving at each node - a node with none can never be reached. */
  inDegree: Uint16Array;
  /**
   * 1 for nodes in the city's main street network - reachable from it AND
   * able to get back to it. Park paths and private service roads form
   * small islands; a rider-placed stop snapped onto one has no route in or
   * out, so edited-route stops only snap to these.
   */
  inMainNetwork: Uint8Array;
  /** Set when a trained artifact was found; null means the baseline is in use. */
  modelSource: "trained" | "baseline";
  /**
   * How many freeway/arterial segments the scoring context was built with.
   *
   * Exposed so a test can assert the engine is wired to the real ~5,600-road
   * dataset rather than the 7 mock shapes. Without this the wiring is
   * untestable from outside: a test that builds its own feature context
   * passes happily while production silently scores against mock data.
   */
  highwaySegmentCount: number;
  /** Crash records scored against, and where they came from - asserted by tests so a revert to mock data cannot pass silently. */
  crashCount: number;
  crashSource: string;
  /** Outcome of reconciling OSM tags against SFMTA's official bikeway network. */
  laneMatch: LaneMatchStats;
  /** Per-edge: does this edge's midpoint sit inside a flagged neighbourhood? */
  inFlaggedArea: Uint8Array;
  /** Bit i set when the edge lies in SF_DANGEROUS_NEIGHBORHOODS[i] - see areaPolicy. */
  areaMask: Uint32Array;
  /** Per directed edge: metres climbed travelling from `from` to `to` (negative = descent). */
  climbMeters: Float32Array;
  /** Per node: ground elevation in metres. */
  nodeElevation: Float32Array;
  /**
   * Per directed edge: extra effective metres charged for climbing it when
   * "avoid elevation" is on. Precomputed so the A* inner loop pays an
   * array lookup, not geometry and list matching.
   */
  elevationPenalty: Float32Array;
  /** Per directed edge: the listed severity this edge triggered, if any. */
  steepSeverity: (SteepSeverity | null)[];
  /**
   * Per node: index of the traffic signal at this intersection, or -1.
   * Several nodes can share one signal (dual carriageways, wide
   * intersections), which is why routes count signals by id, not by node.
   */
  signalAtNode: Int32Array;
  /** Signals that matched at least one graph node. */
  signalsMatched: number;
}

/**
 * Flat-equivalent metres charged for riding through a signalised
 * intersection when "fewer traffic lights" is on. A typical signal costs
 * a cyclist ~25-30s of waiting on average; at ~4 m/s that is ~110m of
 * riding. Rounded to 120.
 */
const SIGNAL_COST_METERS = 120;
/**
 * A signal applies to graph nodes within this radius. Signal points sit at
 * the intersection centre, while OSM puts a node on each carriageway, so
 * an exact-nearest match misses the far side of a wide junction.
 */
const SIGNAL_MATCH_METERS = 18;

/**
 * Flat-equivalent metres charged per metre of elevation CHANGE - climbed
 * or descended - when avoiding hills. The owner asked for "least change",
 * not just least climbing.
 *
 * Worth knowing: on a trip from A to B, total descent = total climb -
 * (height(B) - height(A)), and that last term is fixed for the trip. So
 * under a purely linear charge, "least total change" and "least climbing"
 * pick the SAME route. What charging descents actually changes is the
 * non-linear part: the steep surcharge, the wall cost and the owner's
 * severity list now apply to steep DOWNHILL blocks too, which matter on a
 * bike (braking, speed) and used to cost nothing.
 *
 * Original tuning note, per metre climbed: Deliberately above the 8-12m cycling rule of thumb for
 * effort: this mode is opt-in, and a rider who switches on "avoid hills"
 * wants hills avoided, not merely discounted. Swept across four hilly
 * trips: at 10 the aggregate climbing fell 25% but individual routes like
 * Marina Green -> Union Square kept a 13.4% block; at 25 climbing falls
 * 30%, that block becomes 6.5%, and aggregate distance does not grow at
 * all (the safest profile stops taking quiet-but-steep detours). Severity
 * from the owner's list multiplies this on top.
 */
const CLIMB_COST_PER_METRE = 25;
/**
 * Above this grade a block is a wall many riders walk. Charged an extra
 * flat-equivalent cost per metre of length on top of the climb penalty,
 * rather than made impassable, so a destination that genuinely sits at
 * the top of one is still reachable.
 */
const WALL_GRADE = 0.15;
const WALL_COST_PER_METRE = 25;
/**
 * Grade above which a climb is charged superlinearly. A 15% wall is not
 * merely twice as bad as a 7.5% incline for a cyclist - past roughly 8%
 * many riders have to walk.
 */
const STEEP_SURCHARGE_GRADE = 0.08;
/**
 * Edges shorter than this get their grade taken from a smoothed estimate
 * rather than trusted directly: at ~10m DEM resolution a 6m OSM fragment
 * can show 20% from interpolation noise alone.
 */
const MIN_EDGE_FOR_GRADE_METERS = 15;

function steepAreaAt(p: LatLng, areas: SteepArea[]): SteepArea | null {
  let worst: SteepArea | null = null;
  for (const a of areas) {
    const dLat = (p.lat - a.center.lat) * 111_320;
    const dLng = (p.lng - a.center.lng) * 111_320 * Math.cos((p.lat * Math.PI) / 180);
    if (Math.sqrt(dLat * dLat + dLng * dLng) > a.radiusMeters) continue;
    if (!worst || SEVERITY_MULTIPLIER[a.severity] > SEVERITY_MULTIPLIER[worst.severity]) worst = a;
  }
  return worst;
}

interface ElevationFile {
  format: string;
  graphGeneratedAt: string;
  nodeCount: number;
  elevDm: number[];
}

let engine: RoutingEngine | null = null;

/**
 * Loads a trained model artifact if one has been committed, else falls back
 * to the hand-tuned baseline.
 *
 * The *absence* of an artifact is a normal, expected state (nothing has
 * been trained yet) and falls back quietly. A present-but-broken artifact
 * throws - see the note in `lib/scoring/artifact.ts` on why a silent
 * fallback there would be the worst of both worlds.
 */
const ARTIFACT_PATH = path.join(process.cwd(), "lib", "data", "model", "safety-model.json");

function loadModel(graph: BikeGraph): { model: SafetyModel; source: "trained" | "baseline" } {
  // Read from disk rather than `import` the JSON: a static import of a file
  // that does not exist yet is a hard build failure, and "nothing has been
  // trained yet" has to be a working state. Reading at runtime also means
  // retraining is picked up by restarting the server, with no rebuild.
  //
  // Server-only by construction - `planRoutes` runs in the API route, never
  // in the browser bundle.
  let artifact: unknown;
  try {
    artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  } catch {
    return { model: createBaselineModel(), source: "baseline" };
  }
  const model = loadModelArtifact(artifact, {
    graphEdgeCount: graph.edges.length,
    graphGeneratedAt: graph.generatedAt,
  });
  return { model, source: "trained" };
}

export function getRoutingEngine(): RoutingEngine {
  if (engine) return engine;

  const graph = decodeGraph(rawGraph as Parameters<typeof decodeGraph>[0]);

  // Must run BEFORE features are extracted: `laneProtection` and
  // `isCycleway` read `edge.tier`, so correcting tiers afterwards would
  // leave every score computed from the wrong infrastructure.
  const laneMatch = applySfmtaLaneTiers(graph.edges, graph.nodes, REAL_SF_BIKE_LANES);

  const { model, source } = loadModel(graph);

  const ctx = buildFeatureContext(REAL_SF_BIKE_CRASHES, REAL_SF_HIGHWAYS, graph.nodes);
  const scores = new Float32Array(graph.edges.length);

  // Both directions of a two-way street share identical features, so score
  // each underlying geometry once and reuse. On this graph that is ~50% of
  // the work saved.
  const seen = new Map<string, number>();
  for (const edge of graph.edges) {
    const key = edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`;
    const cached = seen.get(key);
    if (cached !== undefined) {
      scores[edge.id] = cached;
      continue;
    }
    const features = extractFeatures(edge, ctx);
    const s =
      model instanceof PrecomputedScoreModel
        ? model.scoreByEdgeId(edge.id, features)
        : model.score(features);
    scores[edge.id] = s;
    seen.set(key, s);
  }

  // Degree counts, used to refuse snapping onto nodes that cannot work.
  // One-way geometry leaves genuine stubs: the node nearest Union Square
  // has in-degree 0, so it can be left but never arrived at, and routing
  // to it failed with "No bike route found" for a famous landmark.
  const outDegree = new Uint16Array(graph.nodes.length);
  const inDegree = new Uint16Array(graph.nodes.length);
  for (const e of graph.edges) {
    if (outDegree[e.from] < 65535) outDegree[e.from]++;
    if (inDegree[e.to] < 65535) inDegree[e.to]++;
  }

  const spatialIndex = new NodeSpatialIndex(graph.nodes);

  // Precomputed once: which edges lie inside a flagged neighbourhood.
  // The safer profiles refuse these outright, so this has to be a cheap
  // array lookup inside the A* inner loop rather than a geometry test.
  const inFlaggedArea = new Uint8Array(graph.edges.length);
  const areaMask = new Uint32Array(graph.edges.length);
  if (SF_DANGEROUS_NEIGHBORHOODS.length > 32) throw new Error("areaMask holds at most 32 flagged areas.");
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.from];
    const b = graph.nodes[edge.to];
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const mask = areaBits(mid);
    areaMask[edge.id] = mask;
    if (mask !== 0) inFlaggedArea[edge.id] = 1;
  }

  // ELEVATION. Heights are per node index, which is positional, so a
  // regenerated graph would silently pair streets with the wrong heights.
  // Refuse rather than mis-route - same rule as the model artifact.
  const elev = rawElevation as ElevationFile;
  if (elev.graphGeneratedAt !== graph.generatedAt || elev.nodeCount !== graph.nodes.length) {
    throw new Error(
      `Elevation data was sampled for a different graph (${elev.graphGeneratedAt}, ` +
        `${elev.nodeCount} nodes) than the one loaded (${graph.generatedAt}, ` +
        `${graph.nodes.length} nodes). Re-run: npm run data:fetch-elevation`
    );
  }
  const climbMeters = new Float32Array(graph.edges.length);
  const elevationPenalty = new Float32Array(graph.edges.length);
  const steepSeverity: (SteepSeverity | null)[] = new Array(graph.edges.length).fill(null);
  for (const edge of graph.edges) {
    const climb = (elev.elevDm[edge.to] - elev.elevDm[edge.from]) / 10;
    climbMeters[edge.id] = climb;
    // Up or down, every metre of change counts - see CLIMB_COST_PER_METRE.
    const change = Math.abs(climb);
    if (change === 0) continue;

    // Grade, with short fragments clamped so DEM interpolation noise on a
    // 6m sliver cannot masquerade as a 20% wall.
    const run = Math.max(edge.lengthMeters, MIN_EDGE_FOR_GRADE_METERS);
    const grade = change / run;

    // Severity from the owner's list - but only where the terrain confirms
    // the block is genuinely steep. Flat 24th Street in the Mission is
    // never penalised however it is named.
    let sev: SteepSeverity | null = null;
    if (grade >= STEEP_GRADE_THRESHOLD) {
      const byStreet = edge.name ? SF_STEEP_STREETS[edge.name] : undefined;
      const a = graph.nodes[edge.from];
      const b = graph.nodes[edge.to];
      const area = steepAreaAt({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, SF_STEEP_AREAS);
      const candidates = [byStreet, area?.severity].filter(Boolean) as SteepSeverity[];
      for (const c of candidates) {
        if (!sev || SEVERITY_MULTIPLIER[c] > SEVERITY_MULTIPLIER[sev]) sev = c;
      }
    }
    steepSeverity[edge.id] = sev;

    const steepFactor = grade > STEEP_SURCHARGE_GRADE ? 1 + (grade - STEEP_SURCHARGE_GRADE) * 25 : 1;
    const listFactor = sev ? SEVERITY_MULTIPLIER[sev] : 1;
    elevationPenalty[edge.id] =
      change * CLIMB_COST_PER_METRE * steepFactor * listFactor +
      (grade > WALL_GRADE ? edge.lengthMeters * WALL_COST_PER_METRE : 0);
  }

  // TRAFFIC SIGNALS -> intersections. A coarse grid of nodes makes the
  // radius search cheap for 1,300 signals against 112k nodes.
  const signals = (rawSignals as { signals: { lat: number; lng: number }[] }).signals;
  const CELL = 0.0006; // ~60m
  const nodeGrid = new Map<string, number[]>();
  graph.nodes.forEach((p, i) => {
    const k = `${Math.floor(p.lat / CELL)},${Math.floor(p.lng / CELL)}`;
    const b = nodeGrid.get(k);
    if (b) b.push(i);
    else nodeGrid.set(k, [i]);
  });
  const signalAtNode = new Int32Array(graph.nodes.length).fill(-1);
  let signalsMatched = 0;
  signals.forEach((sig, si) => {
    const r0 = Math.floor(sig.lat / CELL);
    const c0 = Math.floor(sig.lng / CELL);
    let hit = false;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const i of nodeGrid.get(`${r0 + dr},${c0 + dc}`) ?? []) {
          const n = graph.nodes[i];
          const dLat = (n.lat - sig.lat) * 111_320;
          const dLng = (n.lng - sig.lng) * 111_320 * Math.cos((sig.lat * Math.PI) / 180);
          if (Math.sqrt(dLat * dLat + dLng * dLng) <= SIGNAL_MATCH_METERS) {
            signalAtNode[i] = si;
            hit = true;
          }
        }
      }
    }
    if (hit) signalsMatched++;
  });

  const nodeElevation = Float32Array.from(elev.elevDm, (dm) => dm / 10);

  engine = {
    graph,
    nodeElevation,
    signalAtNode,
    signalsMatched,
    climbMeters,
    elevationPenalty,
    steepSeverity,
    inFlaggedArea,
    areaMask,
    outDegree,
    inDegree,
    inMainNetwork: mainNetwork(graph),
    index: spatialIndex,
    scores,
    model,
    modelSource: source,
    highwaySegmentCount: REAL_SF_HIGHWAYS.length,
    crashCount: REAL_SF_BIKE_CRASHES.length,
    crashSource: REAL_SF_BIKE_CRASHES[0]?.source ?? "none",
    laneMatch,
  };
  return engine;
}

/** Exposed so tests can force a rebuild after swapping fixtures. */
export function resetRoutingEngine() {
  engine = null;
}

export interface RouteSummary {
  profile: RouteProfile["id"];
  label: string;
  path: LatLng[];
  distanceMeters: number;
  /** Length-weighted mean danger score, 0-100 - the headline safety number. */
  meanDanger: number;
  /** Worst single edge the route uses. */
  maxDanger: number;
  /** Fraction of the ride on fully/semi-protected infrastructure, 0-1. */
  protectedLaneFraction: number;
  /** Metres ridden on each lane tier. */
  tierBreakdown: Record<BikeLaneTier, number>;
  /** Named streets the route uses, in order, deduped - a crude turn list. */
  streets: string[];
  /**
   * Where each named street starts and ends along the route, in metres.
   *
   * `streets` alone cannot answer "what am I riding on right now", which
   * is what the 3D tour needs as the camera moves: it has an ordered list
   * of names but no idea where along the route each one applies.
   */
  streetSpans: { name: string; startMeters: number; endMeters: number }[];
  /**
   * Flagged neighbourhoods the route passes through, with how far it rides
   * inside each. The headline "did it actually avoid them?" number - a
   * mean-danger improvement can hide a route that still crosses the same
   * districts on marginally better streets.
   */
  neighborhoodsEntered: {
    name: string;
    meters: number;
    tier: AreaTier;
    /** The start or destination is inside this area, so it could not be avoided. */
    atEndpoint: boolean;
  }[];
  /**
   * Set when a safer profile went through High/Elevated areas on purpose
   * because staying out of all of them broke AREA_DETOUR_LIMIT.
   * `avoidAllExtraPercent` is how much longer than Fastest the stay-out
   * route was (null when no stay-out route exists at all).
   */
  areaTradeoff?: { avoidAllExtraPercent: number | null; limitPercent: number } | null;
  /** Total distance ridden inside any flagged neighbourhood. */
  metersInFlaggedAreas: number;
  /**
   * Stretches of protected cycling infrastructure, positioned along the
   * route, so the tour can call them out as it reaches them.
   *
   * Only fully/semi-protected tiers: painted lanes and sharrows are not
   * an achievement worth announcing, and labelling them as one would make
   * the callouts meaningless.
   */
  protectedSpans: {
    tier: "fullyProtected" | "semiProtected";
    name: string | null;
    startMeters: number;
    endMeters: number;
  }[];
  /**
   * Flagged neighbourhoods THE FASTEST ROUTE GOES THROUGH that this one
   * does not.
   *
   * Counterfactual, deliberately. An earlier version reported any flagged
   * area within 900m that the route did not enter, which meant all three
   * profiles - including `fastest`, which avoids nothing by design -
   * claimed credit for "avoiding" the Tenderloin on trips that were never
   * going near it. Crediting avoidance the routing did not perform is
   * worse than saying nothing: it makes the one number a rider might
   * actually trust meaningless.
   *
   * Always empty for `fastest`, which is the baseline and cannot avoid
   * anything relative to itself.
   */
  avoidedNearby: { name: string; atMeters: number; closestMeters: number }[];
  /**
   * Road classification along the route, positioned by distance.
   *
   * Drives the tour's illustrative traffic: how busy a street is tracks
   * its class closely, and the class is real OSM data even though no
   * per-street vehicle counts exist for San Francisco.
   */
  classSpans: { roadClass: string; startMeters: number; endMeters: number }[];
  /**
   * Set when this profile costs materially more distance than the fastest
   * route, so the UI can say so rather than quietly handing someone a
   * much longer ride. Null on the fastest route and on modest detours.
   */
  detourWarning: { extraPercent: number; extraMeters: number; message: string } | null;
  /** Total metres climbed along the route - the "elevation gain" a rider feels. */
  elevationGainMeters: number;
  /** Steepest climbing block on the route, as a percentage grade. */
  maxGradePercent: number;
  /** Total metres descended. Gain + loss is the route's total elevation change. */
  elevationLossMeters: number;
  /** Steepest descending block, as a positive percentage grade. */
  maxDownGradePercent: number;
  /**
   * Stretches the route climbs that the owner's steep list flags, merged by
   * street and severity, so the UI can name the hard parts.
   */
  steepClimbs: { name: string; severity: SteepSeverity; meters: number }[];
  /** Whether this route was planned with "avoid elevation" on. */
  avoidedElevation: boolean;
  /**
   * Traffic signals the route rides through, counted once per signal even
   * when an intersection spans several graph nodes.
   */
  trafficSignals: number;
  /** Whether this route was planned with "fewer traffic lights" on. */
  preferredFewerSignals: boolean;
  /** Ground elevation (m) at each vertex of `path`, same length and order. */
  pathElevations: number[];
  /**
   * Set only on a route the rider edited: the stops they chose, in order.
   * The route is still planned on the street graph with `profile`'s rules
   * between each pair of stops - editing picks where to go, not how.
   */
  customWaypoints?: LatLng[];
  /**
   * Suggested edits the rider accepted on this route, as their headlines
   * ("Save 4 min via Castro Street - costs +120 ft climbing"). A suggestion
   * can knowingly break a setting - a faster section that climbs although
   * "Avoid hills" is on - so the route has to say so.
   */
  acceptedSuggestions?: string[];
}

/** Above this much extra distance versus the fastest route, say so plainly. */
const DETOUR_WARN_THRESHOLD = 0.5;

/**
 * How close a route must pass to a flagged area for skirting it to count
 * as avoidance worth reporting. Beyond this the area simply was not on
 * the way.
 */
const NEAR_MISS_RADIUS_METERS = 900;

/** Planar metres between two points - fine at city scale. */
function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Which flagged areas contain this point. */
// ---------------------------------------------------------------------------
// FLAGGED AREAS: how far the safer profiles go to stay out of them.
//
// The owner's rule: Severe areas are skipped whatever the detour. High and
// Elevated areas are skipped too - unless staying out of them makes the
// detour significant, in which case a smaller detour through them is
// better than, say, 20 extra minutes on a 30 minute ride.
//
// So, per safer profile:
//   1. "strict": every flagged area blocked. Used if the result is at most
//      AREA_DETOUR_LIMIT longer than the fastest route.
//   2. "budget": Severe still blocked; High/Elevated allowed at a price -
//      each metre inside costs AREA_COST_PER_METRE extra metres of riding,
//      so the route goes through only where going round costs more.
//   3. "off": nothing blocked (only if 1 and 2 find no route at all).
// An area containing the start or destination cannot be avoided; it is
// exempt from blocking (priced instead, so the route leaves it directly)
// and - unlike before - exempting it no longer switches off avoidance of
// every OTHER area.

export type AreaTier = "Severe" | "High" | "Elevated";
/** Avoiding High/Elevated areas may lengthen the trip by at most this vs Fastest. */
export const AREA_DETOUR_LIMIT = 0.4;
/** Extra metres charged per metre ridden inside an area, when it is allowed at all. */
export const AREA_COST_PER_METRE: Record<AreaTier, number> = {
  Severe: 3, // only ever paid inside an exempt (start/end) area: leave it fast
  High: 1,
  Elevated: 0.3,
};

export function areaTier(risk: number): AreaTier {
  return risk >= 85 ? "Severe" : risk >= 70 ? "High" : "Elevated";
}

const SEVERE_BITS = SF_DANGEROUS_NEIGHBORHOODS.reduce(
  (m, a, i) => (areaTier(a.risk) === "Severe" ? m | (1 << i) : m),
  0
);

function areaBits(p: LatLng): number {
  let mask = 0;
  SF_DANGEROUS_NEIGHBORHOODS.forEach((a, i) => {
    const dLat = (p.lat - a.center.lat) * 111_320;
    const dLng = (p.lng - a.center.lng) * 111_320 * Math.cos((p.lat * Math.PI) / 180);
    if (Math.sqrt(dLat * dLat + dLng * dLng) <= a.radiusMeters) mask |= 1 << i;
  });
  return mask;
}

/** Areas containing any of these points - unavoidable, so exempt from blocking. */
export function exemptAreaBits(points: LatLng[]): number {
  return points.reduce((m, p) => m | areaBits(p), 0);
}

export type AreaMode = "strict" | "budget" | "off";

export function areaPolicy(eng: RoutingEngine, exempt: number, mode: AreaMode) {
  const blockedBits = mode === "strict" ? ~exempt : mode === "budget" ? SEVERE_BITS & ~exempt : 0;
  const rateOf = (mask: number) => {
    let rate = 0;
    for (let i = 0; mask; i++, mask >>>= 1) {
      if (mask & 1) rate = Math.max(rate, AREA_COST_PER_METRE[areaTier(SF_DANGEROUS_NEIGHBORHOODS[i].risk)]);
    }
    return rate;
  };
  return {
    blocked: (edgeId: number) => (eng.areaMask[edgeId] & blockedBits) !== 0,
    // Anything inside an area that is not blocked is priced: exempt areas
    // (to leave them directly) and, in budget mode, High/Elevated ones.
    penalty: (edgeId: number) => {
      const priced = eng.areaMask[edgeId] & ~blockedBits;
      return priced ? eng.graph.edges[edgeId].lengthMeters * rateOf(priced) : 0;
    },
  };
}

function areasContaining(p: LatLng, areas: DangerousNeighborhood[]): DangerousNeighborhood[] {
  const out: DangerousNeighborhood[] = [];
  for (const a of areas) {
    const dLat = (p.lat - a.center.lat) * 111_320;
    const dLng = (p.lng - a.center.lng) * 111_320 * Math.cos((p.lat * Math.PI) / 180);
    if (Math.sqrt(dLat * dLat + dLng * dLng) <= a.radiusMeters) out.push(a);
  }
  return out;
}

function summarize(
  route: RoutePath,
  scores: Float32Array,
  profile: RouteProfile,
  nodes: LatLng[],
  /** Areas the baseline route enters; avoidance is claimed only against these. */
  baselineEntered: Set<string> = new Set(),
  /** Fastest route's length, for the detour warning. Zero on the baseline itself. */
  baselineMeters = 0,
  elevation: {
    climbMeters: Float32Array;
    steepSeverity: (SteepSeverity | null)[];
    avoidElevation: boolean;
    signalAtNode?: Int32Array;
    fewerSignals?: boolean;
    nodeElevation?: Float32Array;
    /** Names of areas containing the start or destination. */
    endpointAreas?: Set<string>;
  } | null = null
): RouteSummary {
  const tierBreakdown: Record<BikeLaneTier, number> = {
    fullyProtected: 0,
    semiProtected: 0,
    unprotected: 0,
    none: 0,
  };
  let weightedDanger = 0;
  let maxDanger = 0;
  const streets: string[] = [];
  const streetSpans: { name: string; startMeters: number; endMeters: number }[] = [];
  const perArea = new Map<string, number>();
  const entered = new Set<string>();
  const closest = new Map<string, { closestMeters: number; atMeters: number }>();
  const protectedSpans: RouteSummary["protectedSpans"] = [];
  const classSpans: RouteSummary["classSpans"] = [];
  let gain = 0;
  let maxGrade = 0;
  let loss = 0;
  let maxDownGrade = 0;
  const steep = new Map<string, { meters: number; severity: SteepSeverity }>();
  const signalsSeen = new Set<number>();
  let metersInFlaggedAreas = 0;
  let travelled = 0;

  for (const e of route.edges) {
    const s = scores[e.id];
    weightedDanger += s * e.lengthMeters;
    if (s > maxDanger) maxDanger = s;
    tierBreakdown[e.tier] += e.lengthMeters;
    if (e.name && streets[streets.length - 1] !== e.name) streets.push(e.name);

    if (e.name) {
      const last = streetSpans[streetSpans.length - 1];
      // Extend the current span rather than starting a new one when the
      // street has not changed - OSM splits a single street into many
      // edges, and one span per edge would make the label flicker every
      // few metres.
      //
      // The contiguity check matters: without it a route that returns to
      // an earlier street (A -> B -> A, common with one-way pairs) merged
      // the second visit into the FIRST span, so that span swallowed B's
      // range entirely and the tour captioned B's blocks with A's name.
      if (last && last.name === e.name && Math.abs(last.endMeters - travelled) < 1) {
        last.endMeters = travelled + e.lengthMeters;
      }
      else
        streetSpans.push({
          name: e.name,
          startMeters: travelled,
          endMeters: travelled + e.lengthMeters,
        });
    }

    // Attributed by edge midpoint - an edge is counted as wholly inside or
    // wholly outside. At SF block scale (~100m edges against 400m+ areas)
    // the boundary error is small, and the alternative (clipping each edge
    // to each circle) buys precision the circles themselves do not have.
    const a = nodes[e.from];
    const b = nodes[e.to];
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const inside = areasContaining(mid, SF_DANGEROUS_NEIGHBORHOODS);
    if (inside.length > 0) metersInFlaggedAreas += e.lengthMeters;
    for (const area of inside) {
      perArea.set(area.name, (perArea.get(area.name) ?? 0) + e.lengthMeters);
      entered.add(area.name);
    }

    // Closest approach to every flagged area, and where along the route it
    // happens - the basis for "avoided X" callouts below.
    for (const area of SF_DANGEROUS_NEIGHBORHOODS) {
      const d = Math.max(0, distanceMeters(mid, area.center) - area.radiusMeters);
      const prev = closest.get(area.name);
      if (!prev || d < prev.closestMeters) {
        closest.set(area.name, { closestMeters: d, atMeters: travelled + e.lengthMeters / 2 });
      }
    }

    {
      const last = classSpans[classSpans.length - 1];
      if (last && last.roadClass === e.roadClass) last.endMeters = travelled + e.lengthMeters;
      else
        classSpans.push({
          roadClass: e.roadClass,
          startMeters: travelled,
          endMeters: travelled + e.lengthMeters,
        });
    }

    if (e.tier === "fullyProtected" || e.tier === "semiProtected") {
      const last = protectedSpans[protectedSpans.length - 1];
      // Merge consecutive protected edges of the same tier AND the same
      // name, so one lane reads as one callout rather than dozens of OSM
      // fragments - but never across a name change. Merging on tier alone
      // let a span that began on "Sloat Boulevard" run on into "Sloat Blvd
      // bikeway" while still captioned with the first name, so the banner
      // named a street the rider had already left.
      if (
        last &&
        last.tier === e.tier &&
        last.name === e.name &&
        Math.abs(last.endMeters - travelled) < 1
      ) {
        last.endMeters = travelled + e.lengthMeters;
      } else {
        protectedSpans.push({
          tier: e.tier,
          name: e.name,
          startMeters: travelled,
          endMeters: travelled + e.lengthMeters,
        });
      }
    }

    if (elevation) {
      const climb = elevation.climbMeters[e.id];
      if (climb < 0) {
        loss -= climb;
        if (e.lengthMeters >= 25) maxDownGrade = Math.max(maxDownGrade, -climb / e.lengthMeters);
      }
      if (climb > 0) {
        gain += climb;
        // Ignore grades on very short fragments: at ~10m DEM resolution a
        // few-metre sliver can read as a wall from interpolation alone.
        if (e.lengthMeters >= 25) maxGrade = Math.max(maxGrade, climb / e.lengthMeters);
        const sev = elevation.steepSeverity[e.id];
        if (sev) {
          // One entry per street, at its WORST severity - listing the same
          // street twice at two severities reads as two different climbs.
          const name = e.name ?? "Unnamed path";
          const prev = steep.get(name);
          steep.set(name, {
            meters: (prev?.meters ?? 0) + e.lengthMeters,
            severity:
              prev && SEVERITY_MULTIPLIER[prev.severity] >= SEVERITY_MULTIPLIER[sev] ? prev.severity : sev,
          });
        }
      }
    }

    if (elevation?.signalAtNode) {
      const sig = elevation.signalAtNode[e.to];
      // Collected by signal id in a Set, so a dual-carriageway junction the
      // route touches at several nodes is still one light.
      if (sig >= 0) signalsSeen.add(sig);
    }

    // MUST be the last statement in the loop. It used to sit just after
    // the streetSpans block, which meant everything computed below it -
    // protectedSpans, classSpans and the per-area closest approach - was
    // offset by one edge length. On the ground that put a protected-lane
    // callout ~58m past the point where the street name changed, so the
    // tour captioned "Oak Street" while the rider was already on the Oak
    // Street Cyclepath, and in the worst cases named an entirely
    // different road.
    travelled += e.lengthMeters;
  }

  const dist = Math.max(1, route.distanceMeters);
  return {
    profile: profile.id,
    label: profile.label,
    path: route.path,
    distanceMeters: Math.round(route.distanceMeters),
    meanDanger: Math.round((weightedDanger / dist) * 10) / 10,
    maxDanger: Math.round(maxDanger * 10) / 10,
    protectedLaneFraction:
      Math.round(((tierBreakdown.fullyProtected + tierBreakdown.semiProtected) / dist) * 1000) /
      1000,
    tierBreakdown,
    streets,
    streetSpans: streetSpans.map((sp) => ({
      name: sp.name,
      startMeters: Math.round(sp.startMeters),
      endMeters: Math.round(sp.endMeters),
    })),
    neighborhoodsEntered: [...perArea.entries()]
      .map(([name, meters]) => ({
        name,
        meters: Math.round(meters),
        tier: areaTier(SF_DANGEROUS_NEIGHBORHOODS.find((a) => a.name === name)?.risk ?? 0),
        atEndpoint: elevation?.endpointAreas?.has(name) ?? false,
      }))
      .sort((x, y) => y.meters - x.meters),
    metersInFlaggedAreas: Math.round(metersInFlaggedAreas),
    // Short slivers are OSM fragmentation, not a protected lane you would
    // notice riding; announcing them would bury the real ones.
    protectedSpans: protectedSpans
      .filter((sp) => sp.endMeters - sp.startMeters >= 60)
      .map((sp) => ({
        tier: sp.tier,
        name: sp.name,
        startMeters: Math.round(sp.startMeters),
        endMeters: Math.round(sp.endMeters),
      })),
    elevationGainMeters: Math.round(gain),
    maxGradePercent: Math.round(maxGrade * 1000) / 10,
    elevationLossMeters: Math.round(loss),
    maxDownGradePercent: Math.round(maxDownGrade * 1000) / 10,
    steepClimbs: [...steep.entries()]
      .map(([name, v]) => ({ name, severity: v.severity, meters: Math.round(v.meters) }))
      .filter((c) => c.meters >= 30)
      .sort(
        (x, y) =>
          SEVERITY_MULTIPLIER[y.severity] - SEVERITY_MULTIPLIER[x.severity] || y.meters - x.meters
      ),
    avoidedElevation: elevation?.avoidElevation ?? false,
    trafficSignals: signalsSeen.size,
    preferredFewerSignals: elevation?.fewerSignals ?? false,
    // path[0] is the start node, then one vertex per edge's `to` node -
    // the same order astar's reconstruct builds `path` in.
    pathElevations: elevation?.nodeElevation
      ? [
          route.edges.length ? elevation.nodeElevation[route.edges[0].from] : 0,
          ...route.edges.map((e) => elevation.nodeElevation![e.to]),
        ].map((m) => Math.round(m * 10) / 10)
      : [],
    detourWarning:
      baselineMeters > 0 && route.distanceMeters > baselineMeters * (1 + DETOUR_WARN_THRESHOLD)
        ? {
            extraPercent:
              Math.round(((route.distanceMeters - baselineMeters) / baselineMeters) * 1000) / 10,
            extraMeters: Math.round(route.distanceMeters - baselineMeters),
            message: `This route is ${Math.round(
              ((route.distanceMeters - baselineMeters) / baselineMeters) * 100
            )}% longer than the fastest route (${(
              (route.distanceMeters - baselineMeters) / 1609.34
            ).toFixed(1)} mi further) to stay clear of flagged areas and keep to protected lanes.`,
          }
        : null,
    classSpans: classSpans.map((c) => ({
      roadClass: c.roadClass,
      startMeters: Math.round(c.startMeters),
      endMeters: Math.round(c.endMeters),
    })),
    avoidedNearby: [...closest.entries()]
      .filter(
        ([name, c]) =>
          // Not entered by us, DID get entered by the baseline, and close
          // enough that steering round it was a real routing decision.
          !entered.has(name) &&
          baselineEntered.has(name) &&
          c.closestMeters <= NEAR_MISS_RADIUS_METERS
      )
      .map(([name, c]) => ({
        name,
        atMeters: Math.round(c.atMeters),
        closestMeters: Math.round(c.closestMeters),
      }))
      .sort((a, b) => a.atMeters - b.atMeters),
  };
}

export class RoutingError extends Error {}

/**
 * Plans all three route profiles between two points.
 *
 * Each profile is an independent A* run over the same graph and scores,
 * differing only in how `edgeCost` weighs danger against distance - so
 * "safest" is not a perturbation of "fastest" the way the old waypoint-
 * nudging approach was, but genuinely the lowest-danger path the network
 * admits.
 */
/**
 * True when this edge rides INTO a signalised intersection from outside it.
 * Edges between two nodes of the same signal (crossing the junction, or
 * stepping between carriageways) are not a new light and are not charged.
 */
export function edgeEntersSignal(eng: RoutingEngine, edgeId: number): boolean {
  const e = eng.graph.edges[edgeId];
  const to = eng.signalAtNode[e.to];
  return to >= 0 && eng.signalAtNode[e.from] !== to;
}

export interface PlanOptions {
  /**
   * Charge for climbing on every profile, so routes go around hills where
   * a reasonable detour exists. Off by default: in a city this hilly it
   * reshapes almost every route, and a rider who is fine with climbs
   * should not pay detours for it.
   */
  avoidElevation?: boolean;
  /**
   * Charge for each signalised intersection, so routes prefer streets with
   * fewer traffic lights. Framed as convenience, not safety: a light-free
   * route is quicker and smoother, but a signal can also be the safest way
   * across a busy arterial, so this never overrides the safety profiles'
   * hard constraints.
   */
  fewerSignals?: boolean;
}

export function planRoutes(
  origin: LatLng,
  destination: LatLng,
  options: PlanOptions = {}
): RouteSummary[] {
  const avoidElevation = options.avoidElevation ?? false;
  const fewerSignals = options.fewerSignals ?? false;
  const eng = getRoutingEngine();

  // Snap to nodes that can actually serve as an origin and a destination.
  // Nearest-node alone is not enough: one-way stubs exist with in-degree
  // or out-degree 0, and landing on one makes the search unsolvable no
  // matter how well connected the rest of the city is.
  const startNode = eng.index.nearest(origin, 2000, (i) => eng.outDegree[i] > 0);
  if (startNode === null) {
    throw new RoutingError("Start point is not near any bike-routable street in the covered area.");
  }
  const goalNode = eng.index.nearest(destination, 2000, (i) => eng.inDegree[i] > 0);
  if (goalNode === null) {
    throw new RoutingError(
      "Destination is not near any bike-routable street in the covered area."
    );
  }
  if (startNode === goalNode) {
    throw new RoutingError("Start and destination resolve to the same point.");
  }

  const scoreOf = (edgeId: number) => eng.scores[edgeId];
  const out: RouteSummary[] = [];
  // The fastest route is computed first and becomes the baseline every
  // other profile's avoidance claims are measured against.
  let baselineEntered = new Set<string>();
  let baselineMeters = 0;

  for (const id of ["fastest", "balanced", "safest"] as const) {
    const profile = ROUTE_PROFILES[id];
    // Opt-in preferences compose additively. A signal is charged once, on
    // the edge that ENTERS its intersection from outside. Charging every
    // edge that arrives at a flagged node over-billed badly: 18m around a
    // signal catches ~7 OSM nodes (crosswalks, curbs, both carriageways),
    // so one junction was charged up to five times and "fewer lights"
    // detoured 44% to dodge them.
    const entersSignal = (edgeId: number) => edgeEntersSignal(eng, edgeId);
    const extraPenalty =
      avoidElevation || fewerSignals
        ? (edgeId: number) =>
            (avoidElevation ? eng.elevationPenalty[edgeId] : 0) +
            (fewerSignals && entersSignal(edgeId) ? SIGNAL_COST_METERS : 0)
        : undefined;
    // Areas holding the start or destination cannot be avoided (see
    // areaPolicy). Checked at both the typed point and the snapped node.
    const exempt = exemptAreaBits([origin, destination, eng.graph.nodes[startNode], eng.graph.nodes[goalNode]]);
    const endpointAreas = new Set(
      SF_DANGEROUS_NEIGHBORHOODS.filter((_, i) => exempt & (1 << i)).map((a) => a.name)
    );
    const search = (p: RouteProfile, mode: AreaMode) => {
      const policy = areaPolicy(eng, exempt, mode);
      return findRoute(eng.graph, scoreOf, startNode, goalNode, p, {
        inFlaggedArea: policy.blocked,
        extraPenalty: (edgeId: number) =>
          (extraPenalty ? extraPenalty(edgeId) : 0) + (p.avoidFlaggedAreas ? policy.penalty(edgeId) : 0),
      });
    };

    let route: RoutePath | null = null;
    let bestEffort = false;
    let areaTradeoff: RouteSummary["areaTradeoff"] = null;
    if (!profile.avoidFlaggedAreas) {
      route = search(profile, "off");
    } else {
      // The area rules, for one danger ceiling:
      //   1. stay out of every area, if that is within the detour limit;
      //   2. otherwise Severe stays blocked and High/Elevated become a
      //      price, so the route goes through only where going round
      //      costs more - and records the trade-off it made.
      const underAreaRules = (p: RouteProfile): { route: RoutePath | null; tradeoff: RouteSummary["areaTradeoff"] } => {
        const strict = search(p, "strict");
        if (strict && strict.distanceMeters <= baselineMeters * (1 + AREA_DETOUR_LIMIT)) {
          return { route: strict, tradeoff: null };
        }
        const budget = search(p, "budget");
        if (budget && (!strict || budget.distanceMeters < strict.distanceMeters)) {
          return {
            route: budget,
            tradeoff: {
              avoidAllExtraPercent: strict
                ? Math.round((strict.distanceMeters / Math.max(1, baselineMeters) - 1) * 100)
                : null,
              limitPercent: Math.round(AREA_DETOUR_LIMIT * 100),
            },
          };
        }
        return { route: strict, tradeoff: null };
      };

      ({ route, tradeoff: areaTradeoff } = underAreaRules(profile));
      // The danger ceiling can wall a trip in. Lift it - but keep the area
      // rules (an earlier fallback skipped straight to pricing areas and
      // rode through Chinatown with no reason given) - and only then, as
      // a last resort, stop blocking Severe areas.
      if (!route) {
        const lifted = { ...profile, hardAvoidScore: Infinity };
        ({ route, tradeoff: areaTradeoff } = underAreaRules(lifted));
        if (!route) route = search(lifted, "off");
        bestEffort = Boolean(route);
      }
    }

    if (route) {
      const summary = summarize(route, eng.scores, profile, eng.graph.nodes, baselineEntered, baselineMeters, {
        climbMeters: eng.climbMeters,
        steepSeverity: eng.steepSeverity,
        avoidElevation,
        signalAtNode: eng.signalAtNode,
        fewerSignals,
        nodeElevation: eng.nodeElevation,
        endpointAreas,
      });
      if (id === "fastest") {
        baselineEntered = new Set(summary.neighborhoodsEntered.map((n) => n.name));
        baselineMeters = summary.distanceMeters;
      }
      // "Best effort" = it could not stay out of every area: the start or
      // destination is inside one, or the fallbacks were needed.
      const unavoidable = profile.avoidFlaggedAreas && summary.neighborhoodsEntered.some((n) => n.atEndpoint);
      out.push({
        ...summary,
        areaTradeoff,
        // Short enough for a tab; the panel explains it in full.
        label: bestEffort || unavoidable ? `${profile.label} · best effort` : summary.label,
      });
    }
  }

  if (out.length === 0) {
    throw new RoutingError("No bike route found between these points.");
  }

  return enforceSafetyOrdering(out);
}

/**
 * Guarantees the obvious promise: "Safest" is never more dangerous than
 * "Safer", which is never more dangerous than "Fastest".
 *
 * This is not cosmetic. The three profiles solve genuinely different
 * optimisation problems - a stricter `hardAvoidScore` shrinks the set of
 * legal routes, so the best route the strict profile can find may be worse,
 * on mean danger, than one the laxer profile was free to pick. Observed
 * live: a Richmond -> Potrero trip where "safest" came back at mean danger
 * 36.6 against "safer" at 35.5, because the 75 ceiling forced it off the
 * better corridor entirely.
 *
 * Both routes are legitimate answers to their own objective, but a rider
 * who picks "Safest" and is handed the more dangerous of two routes we
 * already computed has been actively misled. So when a stricter tier is
 * beaten by a laxer one, it adopts the better route. Tiers can therefore
 * coincide - which is an honest "we could not do better than this" rather
 * than a manufactured difference.
 */
/**
 * One tier showing another tier's route. The "best effort" suffix belongs
 * to the route (it could not avoid every flagged area), so it travels with
 * the route rather than staying with the tier that is adopting it.
 */
function adoptRoute(route: RouteSummary, as: RouteProfile["id"]): RouteSummary {
  const bestEffort = route.label.endsWith("· best effort");
  const base = ROUTE_PROFILES[as].label;
  return { ...route, profile: as, label: bestEffort ? `${base} · best effort` : base };
}

function enforceSafetyOrdering(routes: RouteSummary[]): RouteSummary[] {
  const order: RouteProfile["id"][] = ["fastest", "balanced", "safest"];
  const byProfile = new Map(routes.map((r) => [r.profile, r]));

  for (let i = 1; i < order.length; i++) {
    const stricter = byProfile.get(order[i]);
    const laxer = byProfile.get(order[i - 1]);
    if (!stricter || !laxer) continue;
    // Compare on BOTH promises, not just mean danger. Once the safer
    // profiles hard-avoid flagged areas, their route is often longer and
    // pushed onto arterials, so its mean danger can edge above the
    // fastest route's - and ordering on that number alone silently threw
    // the avoidance away and handed back the fastest route under a
    // "Safest" label. A laxer tier only wins if it is better on danger
    // AND spends no more of the ride inside flagged areas.
    const laxerShare = laxer.metersInFlaggedAreas / Math.max(1, laxer.distanceMeters);
    const stricterShare = stricter.metersInFlaggedAreas / Math.max(1, stricter.distanceMeters);
    if (laxer.meanDanger < stricter.meanDanger && laxerShare <= stricterShare) {
      byProfile.set(order[i], {
        ...laxer,
        profile: stricter.profile,
        label: stricter.label,
      });
    }
  }

  // Distance ladder: "Safest + bike lanes" is Safest with an extra
  // preference, so it must never come out SHORTER than Safest. It can,
  // because the two weigh danger differently: with "Avoid hills" on,
  // Noe Valley -> North Beach gave Safest a flatter 6.06 mi detour while
  // Safest + bike lanes took a hillier 5.56 mi route. When that happens
  // the shorter route is normally a valid Safest route too (it avoids at
  // least as much), so Safest takes it and the two are equal. Only if the
  // bike-lane route had to cross more flagged area than Safest did does it
  // go the other way, so neither option ever gives up area avoidance.
  const balanced = byProfile.get("balanced");
  const safest = byProfile.get("safest");
  if (balanced && safest && safest.distanceMeters < balanced.distanceMeters - 1) {
    if (safest.metersInFlaggedAreas <= balanced.metersInFlaggedAreas) {
      byProfile.set("balanced", adoptRoute(safest, "balanced"));
    } else {
      byProfile.set("safest", adoptRoute(balanced, "safest"));
    }
  }

  return order.map((id) => byProfile.get(id)).filter((r): r is RouteSummary => r != null);
}


/** Most stops a rider can add when editing a route. */
export const MAX_CUSTOM_WAYPOINTS = 8;

/**
 * Plans ONE route that passes through rider-chosen stops, in order, using a
 * single profile's rules and the rider's hill/traffic-light preferences on
 * every leg. This is what "edit the route" runs on: the rider decides where
 * the route goes; the router still picks the safest streets between stops.
 *
 * Each leg is searched separately and the legs are joined. A leg that the
 * strict profile cannot complete (a stop inside a flagged area, say) is
 * relaxed exactly as planRoutes does, and the result is labelled best
 * effort rather than silently breaking the profile's promise.
 */
export function planCustomRoute(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  profileId: RouteProfile["id"],
  options: PlanOptions = {}
): RouteSummary {
  return summarizeCustom(planCustomPath(origin, destination, waypoints, profileId, options), waypoints, profileId, options);
}

/** The joined route itself, before it is summarised - see planCustomRoute. */
export interface CustomPlan {
  path: RoutePath;
  bestEffort: boolean;
  /** Snapped graph nodes: start, each stop, destination. */
  stops: number[];
}

export function planCustomPath(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  profileId: RouteProfile["id"],
  options: PlanOptions = {}
): CustomPlan {
  if (waypoints.length > MAX_CUSTOM_WAYPOINTS) {
    throw new RoutingError(`At most ${MAX_CUSTOM_WAYPOINTS} stops can be added to a route.`);
  }
  const avoidElevation = options.avoidElevation ?? false;
  const fewerSignals = options.fewerSignals ?? false;
  const eng = getRoutingEngine();
  const profile = ROUTE_PROFILES[profileId];

  // Stops are passed THROUGH, so they need a way in and a way out.
  const snap = (p: LatLng, accept: (i: number) => boolean, what: string) => {
    const n = eng.index.nearest(p, 2000, accept);
    if (n === null) throw new RoutingError(`${what} is not near any bike-routable street in the covered area.`);
    return n;
  };
  const stops = [
    snap(origin, (i) => eng.outDegree[i] > 0, "Start point"),
    ...waypoints.map((w, k) => snap(w, (i) => eng.inMainNetwork[i] === 1, `Stop ${k + 1}`)),
    snap(destination, (i) => eng.inDegree[i] > 0, "Destination"),
  ].filter((n, i, all) => i === 0 || n !== all[i - 1]); // two clicks on one corner are one stop
  if (stops.length < 2) throw new RoutingError("Start and destination resolve to the same point.");

  const scoreOf = (edgeId: number) => eng.scores[edgeId];
  const extraPenalty =
    avoidElevation || fewerSignals
      ? (edgeId: number) =>
          (avoidElevation ? eng.elevationPenalty[edgeId] : 0) +
          (fewerSignals && edgeEntersSignal(eng, edgeId) ? SIGNAL_COST_METERS : 0)
      : undefined;
  // A stop the rider placed inside an area makes that area unavoidable for
  // the legs touching it, and only that area.
  const search = (from: number, to: number, p: RouteProfile, mode: AreaMode) => {
    const policy = areaPolicy(eng, exemptAreaBits([eng.graph.nodes[from], eng.graph.nodes[to]]), mode);
    return findRoute(eng.graph, scoreOf, from, to, p, {
      inFlaggedArea: policy.blocked,
      extraPenalty: (edgeId: number) =>
        (extraPenalty ? extraPenalty(edgeId) : 0) + (p.avoidFlaggedAreas ? policy.penalty(edgeId) : 0),
    });
  };

  // Each leg follows the same area rules as the stock routes: stay out of
  // every area if that is within AREA_DETOUR_LIMIT of the leg's fastest
  // line, else price High/Elevated. An earlier version went straight to
  // pricing, so "My route" with no stops was NOT the Safest route it was
  // based on - and suggested edits were measured against the wrong route.
  const legUnderAreaRules = (from: number, to: number, p: RouteProfile) => {
    if (!p.avoidFlaggedAreas) return search(from, to, p, "off");
    const strict = search(from, to, p, "strict");
    const fastest = search(from, to, ROUTE_PROFILES.fastest, "off");
    if (strict && fastest && strict.distanceMeters <= fastest.distanceMeters * (1 + AREA_DETOUR_LIMIT)) return strict;
    const budget = search(from, to, p, "budget");
    return budget && (!strict || budget.distanceMeters < strict.distanceMeters) ? budget : strict;
  };

  let bestEffort = false;
  const joined: RoutePath = { path: [], edges: [], distanceMeters: 0, costMeters: 0 };
  for (let i = 0; i < stops.length - 1; i++) {
    let leg = legUnderAreaRules(stops[i], stops[i + 1], profile);
    if (!leg && profileId !== "fastest") {
      for (const mode of ["budget", "off"] as const) {
        leg = search(stops[i], stops[i + 1], { ...profile, hardAvoidScore: Infinity }, mode);
        if (leg) break;
      }
      bestEffort = bestEffort || Boolean(leg);
    }
    if (!leg) {
      throw new RoutingError(
        `Couldn't find a bike route ${i === 0 ? "from the start" : `from stop ${i}`} to ${
          i === stops.length - 2 ? "the destination" : `stop ${i + 1}`
        }. Try moving the stop onto a nearby street.`
      );
    }
    // Legs share their junction node; keep it once.
    joined.path.push(...(i === 0 ? leg.path : leg.path.slice(1)));
    joined.edges.push(...leg.edges);
    joined.distanceMeters += leg.distanceMeters;
    joined.costMeters += leg.costMeters;
  }
  return { path: joined, bestEffort, stops };
}

/** Summarises a custom path (planned, or spliced by suggested edits) as "My route". */
export function summarizeCustom(
  plan: CustomPlan,
  waypoints: LatLng[],
  profileId: RouteProfile["id"],
  options: PlanOptions = {}
): RouteSummary {
  const avoidElevation = options.avoidElevation ?? false;
  const fewerSignals = options.fewerSignals ?? false;
  const eng = getRoutingEngine();
  const profile = ROUTE_PROFILES[profileId];
  const { path: joined, bestEffort, stops } = plan;
  // Same penalties as the stock fastest route, so the detour warning and
  // avoidance claims measure against the identical baseline.
  const search = (from: number, to: number, p: RouteProfile) =>
    findRoute(eng.graph, (edgeId: number) => eng.scores[edgeId], from, to, p, {
      extraPenalty: (edgeId: number) =>
        (avoidElevation ? eng.elevationPenalty[edgeId] : 0) +
        (fewerSignals && edgeEntersSignal(eng, edgeId) ? SIGNAL_COST_METERS : 0),
    });

  // Avoidance claims and the detour warning are measured against the plain
  // fastest A->B route, exactly as for the three standard options.
  const baseline = search(stops[0], stops[stops.length - 1], ROUTE_PROFILES.fastest);
  const baselineSummary = baseline
    ? summarize(baseline, eng.scores, ROUTE_PROFILES.fastest, eng.graph.nodes)
    : null;
  const summary = summarize(
    joined,
    eng.scores,
    profile,
    eng.graph.nodes,
    new Set(baselineSummary?.neighborhoodsEntered.map((n) => n.name) ?? []),
    baselineSummary?.distanceMeters ?? 0,
    {
      climbMeters: eng.climbMeters,
      steepSeverity: eng.steepSeverity,
      avoidElevation,
      signalAtNode: eng.signalAtNode,
      fewerSignals,
      nodeElevation: eng.nodeElevation,
      // Areas holding the start, the destination or a stop the rider chose.
      endpointAreas: new Set(
        SF_DANGEROUS_NEIGHBORHOODS.filter(
          (_, i) => exemptAreaBits(stops.map((n) => eng.graph.nodes[n])) & (1 << i)
        ).map((a) => a.name)
      ),
    }
  );
  const unavoidable = profile.avoidFlaggedAreas && summary.neighborhoodsEntered.some((n) => n.atEndpoint);
  return {
    ...summary,
    label: `My route (${profile.label})${bestEffort || unavoidable ? " · best effort" : ""}`,
    customWaypoints: waypoints,
  };
}


/**
 * The largest strongly connected component of the street graph: every node
 * in it can reach every other. In SF that is nearly the whole network;
 * what falls outside is islands (park paths, private service roads).
 *
 * Kosaraju, iterative (a recursive DFS overflows the stack on 112k nodes).
 * An earlier version seeded from one "central" node and took its
 * component - the seed landed on a 6-node plaza and every stop failed.
 */
function mainNetwork(graph: BikeGraph): Uint8Array {
  const n = graph.nodes.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  const back: number[][] = Array.from({ length: n }, () => []);
  for (const e of graph.edges) {
    out[e.from].push(e.to);
    back[e.to].push(e.from);
  }

  // Pass 1: finish order on the forward graph.
  const order: number[] = [];
  const seen = new Uint8Array(n);
  const next = new Int32Array(n); // per-node cursor into out[]
  for (let root = 0; root < n; root++) {
    if (seen[root]) continue;
    seen[root] = 1;
    const stack = [root];
    while (stack.length) {
      const v = stack[stack.length - 1];
      if (next[v] < out[v].length) {
        const w = out[v][next[v]++];
        if (!seen[w]) {
          seen[w] = 1;
          stack.push(w);
        }
      } else {
        order.push(stack.pop()!);
      }
    }
  }

  // Pass 2: components on the reverse graph, in reverse finish order.
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const root = order[k];
    if (comp[root] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [root];
    comp[root] = id;
    while (stack.length) {
      const v = stack.pop()!;
      size++;
      for (const w of back[v]) if (comp[w] === -1) {
        comp[w] = id;
        stack.push(w);
      }
    }
    sizes.push(size);
  }

  let largest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[largest]) largest = i;
  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) result[i] = comp[i] === largest ? 1 : 0;
  return result;
}


let nodesByPosition: Map<string, number[]> | null = null;
let outEdgesOf: number[][] | null = null;

/**
 * Rebuilds the graph route behind a path the browser is showing. Every
 * route vertex IS a graph node position, so this is an exact lookup, not a
 * map match. Lets the server work on precisely the route on screen (e.g.
 * suggested edits) instead of re-planning something that might differ.
 * Null if the path is not a route on this graph.
 *
 * Positions are not unique - OSM has distinct nodes at identical
 * coordinates (a first version keyed one node per position and failed on
 * a real route) - so each step keeps every candidate node and the chain
 * is resolved by which candidates are actually joined by an edge.
 */
export function routePathFromLatLngs(path: LatLng[]): RoutePath | null {
  const eng = getRoutingEngine();
  if (!nodesByPosition || !outEdgesOf) {
    nodesByPosition = new Map();
    eng.graph.nodes.forEach((n, i) => {
      const k = `${n.lat},${n.lng}`;
      const list = nodesByPosition!.get(k);
      if (list) list.push(i);
      else nodesByPosition!.set(k, [i]);
    });
    outEdgesOf = Array.from({ length: eng.graph.nodes.length }, () => []);
    for (const e of eng.graph.edges) outEdgesOf[e.from].push(e.id);
  }
  if (path.length < 2) return null;
  // Shortest edge from a to b, as A* would have taken.
  const edgeBetween = (a: number, b: number): GraphEdge | null => {
    let best: GraphEdge | null = null;
    for (const id of outEdgesOf![a]) {
      const e = eng.graph.edges[id];
      if (e.to === b && (!best || e.lengthMeters < best.lengthMeters)) best = e;
    }
    return best;
  };
  // Forward pass: for every candidate at step i, the edge that reaches it.
  const cands = path.map((p) => nodesByPosition!.get(`${p.lat},${p.lng}`) ?? []);
  if (cands.some((c) => c.length === 0)) return null;
  const reachedBy: Map<number, GraphEdge | null>[] = [new Map(cands[0].map((n) => [n, null]))];
  for (let i = 1; i < cands.length; i++) {
    const here = new Map<number, GraphEdge | null>();
    for (const b of cands[i]) {
      for (const a of reachedBy[i - 1].keys()) {
        const e = edgeBetween(a, b);
        if (e && !here.has(b)) here.set(b, e);
      }
    }
    if (here.size === 0) return null;
    reachedBy.push(here);
  }
  // Walk back from any reached end node.
  const edges: GraphEdge[] = [];
  let node = reachedBy[reachedBy.length - 1].keys().next().value as number;
  for (let i = reachedBy.length - 1; i > 0; i--) {
    const e = reachedBy[i].get(node)!;
    edges.push(e);
    node = e.from;
  }
  edges.reverse();
  return {
    path: [eng.graph.nodes[edges[0].from], ...edges.map((e) => eng.graph.nodes[e.to])],
    edges,
    distanceMeters: edges.reduce((t, e) => t + e.lengthMeters, 0),
    costMeters: 0,
  };
}
