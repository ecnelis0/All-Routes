import type { BikeLaneTier, LatLng } from "../types";
import { ALL_MOCK_CRASHES, MOCK_HIGHWAY_SEGMENTS } from "../mockData";
import { buildFeatureContext, extractFeatures, type EdgeFeatures } from "../scoring/features";
import { createBaselineModel, PrecomputedScoreModel, type SafetyModel } from "../scoring/model";
import { loadModelArtifact } from "../scoring/artifact";
import { decodeGraph, NodeSpatialIndex, type BikeGraph, type GraphEdge } from "./graph";
import { findRoute, type RoutePath } from "./astar";
import { ROUTE_PROFILES, type RouteProfile } from "./cost";
import rawGraph from "../data/sfBikeGraph.json";

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
function loadModel(graph: BikeGraph): { model: SafetyModel; source: "trained" | "baseline" } {
  let artifact: unknown;
  try {
    // Deliberately dynamic: webpack/turbopack would hard-fail the build on a
    // static import of a file that does not exist yet, and "not trained
    // yet" has to be a working state.

    artifact = require("../data/model/safety-model.json");
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
  const { model, source } = loadModel(graph);

  const ctx = buildFeatureContext(ALL_MOCK_CRASHES, MOCK_HIGHWAY_SEGMENTS, graph.nodes);
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

  engine = { graph, index: new NodeSpatialIndex(graph.nodes), scores, model, modelSource: source };
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
}

function summarize(route: RoutePath, scores: Float32Array, profile: RouteProfile): RouteSummary {
  const tierBreakdown: Record<BikeLaneTier, number> = {
    fullyProtected: 0,
    semiProtected: 0,
    unprotected: 0,
    none: 0,
  };
  let weightedDanger = 0;
  let maxDanger = 0;
  const streets: string[] = [];

  for (const e of route.edges) {
    const s = scores[e.id];
    weightedDanger += s * e.lengthMeters;
    if (s > maxDanger) maxDanger = s;
    tierBreakdown[e.tier] += e.lengthMeters;
    if (e.name && streets[streets.length - 1] !== e.name) streets.push(e.name);
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
          ...summarize(route, eng.scores, profile),
          label: `${profile.label} (no fully-qualifying route; best effort)`,
        });
        continue;
      }
    }

    if (route) out.push(summarize(route, eng.scores, profile));
  }

  if (out.length === 0) {
    throw new RoutingError("No bike route found between these points.");
  }
  return out;
}
