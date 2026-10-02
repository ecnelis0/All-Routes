import { readFileSync } from "node:fs";
import path from "node:path";

import type { BikeLaneTier, LatLng } from "../types";
import { ALL_MOCK_CRASHES } from "../mockData";
import { REAL_SF_HIGHWAYS } from "../dataSources/sfHighways";
import { REAL_SF_BIKE_LANES } from "../dataSources/sfmtaBikeLanes";
import { applySfmtaLaneTiers, type LaneMatchStats } from "../scoring/laneMatch";
import { buildFeatureContext, extractFeatures } from "../scoring/features";
import { createBaselineModel, PrecomputedScoreModel, type SafetyModel } from "../scoring/model";
import { loadModelArtifact } from "../scoring/artifact";
import { decodeGraph, NodeSpatialIndex, type BikeGraph } from "./graph";
import { findRoute, type RoutePath } from "./astar";
import { ROUTE_PROFILES, type RouteProfile } from "./cost";
import rawGraph from "../data/sfBikeGraph.json";
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
  /** Outcome of reconciling OSM tags against SFMTA's official bikeway network. */
  laneMatch: LaneMatchStats;
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

  const ctx = buildFeatureContext(ALL_MOCK_CRASHES, REAL_SF_HIGHWAYS, graph.nodes);
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

  engine = {
    graph,
    index: new NodeSpatialIndex(graph.nodes),
    scores,
    model,
    modelSource: source,
    highwaySegmentCount: REAL_SF_HIGHWAYS.length,
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
  neighborhoodsEntered: { name: string; meters: number }[];
  /** Total distance ridden inside any flagged neighbourhood. */
  metersInFlaggedAreas: number;
}

/** Which flagged areas contain this point. */
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
  nodes: LatLng[]
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
      if (last && last.name === e.name) last.endMeters = travelled + e.lengthMeters;
      else
        streetSpans.push({
          name: e.name,
          startMeters: travelled,
          endMeters: travelled + e.lengthMeters,
        });
    }
    travelled += e.lengthMeters;

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
    }
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
      .map(([name, meters]) => ({ name, meters: Math.round(meters) }))
      .sort((x, y) => y.meters - x.meters),
    metersInFlaggedAreas: Math.round(metersInFlaggedAreas),
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
export function planRoutes(origin: LatLng, destination: LatLng): RouteSummary[] {
  const eng = getRoutingEngine();

  const startNode = eng.index.nearest(origin);
  if (startNode === null) {
    throw new RoutingError("Start point is not near any bike-routable street in the covered area.");
  }
  const goalNode = eng.index.nearest(destination);
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

  for (const id of ["fastest", "balanced", "safest"] as const) {
    const profile = ROUTE_PROFILES[id];
    let route = findRoute(eng.graph, scoreOf, startNode, goalNode, profile);

    // A strict profile can cut the graph into disconnected pieces - if every
    // road out of a neighbourhood scores above `hardAvoidScore`, there is
    // genuinely no qualifying route. Falling back to the next-laxer profile
    // beats returning nothing, but the caller should be able to tell, hence
    // the distinct label.
    if (!route && id !== "fastest") {
      const relaxed: RouteProfile = { ...profile, hardAvoidScore: Infinity };
      route = findRoute(eng.graph, scoreOf, startNode, goalNode, relaxed);
      if (route) {
        out.push({
          ...summarize(route, eng.scores, profile, eng.graph.nodes),
          label: `${profile.label} (no fully-qualifying route; best effort)`,
        });
        continue;
      }
    }

    if (route) out.push(summarize(route, eng.scores, profile, eng.graph.nodes));
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
function enforceSafetyOrdering(routes: RouteSummary[]): RouteSummary[] {
  const order: RouteProfile["id"][] = ["fastest", "balanced", "safest"];
  const byProfile = new Map(routes.map((r) => [r.profile, r]));

  for (let i = 1; i < order.length; i++) {
    const stricter = byProfile.get(order[i]);
    const laxer = byProfile.get(order[i - 1]);
    if (!stricter || !laxer) continue;
    if (laxer.meanDanger < stricter.meanDanger) {
      byProfile.set(order[i], {
        ...laxer,
        profile: stricter.profile,
        label: stricter.label,
      });
    }
  }

  return order.map((id) => byProfile.get(id)).filter((r): r is RouteSummary => r != null);
}
