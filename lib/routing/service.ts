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
  /** Edges leaving each node - a node with none can never be departed. */
  outDegree: Uint16Array;
  /** Edges arriving at each node - a node with none can never be reached. */
  inDegree: Uint16Array;
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
  /** Per-edge: does this edge's midpoint sit inside a flagged neighbourhood? */
  inFlaggedArea: Uint8Array;
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

  // Precomputed once: which edges lie inside a flagged neighbourhood.
  // The safer profiles refuse these outright, so this has to be a cheap
  // array lookup inside the A* inner loop rather than a geometry test.
  const inFlaggedArea = new Uint8Array(graph.edges.length);
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.from];
    const b = graph.nodes[edge.to];
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    if (areasContaining(mid, SF_DANGEROUS_NEIGHBORHOODS).length > 0) inFlaggedArea[edge.id] = 1;
  }

  engine = {
    graph,
    inFlaggedArea,
    outDegree,
    inDegree,
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
  baselineMeters = 0
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
      .map(([name, meters]) => ({ name, meters: Math.round(meters) }))
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
export function planRoutes(origin: LatLng, destination: LatLng): RouteSummary[] {
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
    const inFlagged = (edgeId: number) => eng.inFlaggedArea[edgeId] === 1;
    let route = findRoute(eng.graph, scoreOf, startNode, goalNode, profile, { inFlaggedArea: inFlagged });
    let bestEffort = false;

    // A strict profile can cut the graph into disconnected pieces - if every
    // road out of a neighbourhood scores above `hardAvoidScore`, there is
    // genuinely no qualifying route. Falling back to the next-laxer profile
    // beats returning nothing, but the caller should be able to tell, hence
    // the distinct label.
    if (!route && id !== "fastest") {
      // Hard avoidance can make the goal unreachable - the destination
      // may itself be inside a flagged area, which is common and
      // perfectly legitimate. Relax in stages so the answer degrades
      // rather than disappearing, and say so in the label.
      const stages: RouteProfile[] = [
        { ...profile, avoidFlaggedAreas: false },
        { ...profile, avoidFlaggedAreas: false, hardAvoidScore: Infinity },
      ];
      for (const relaxed of stages) {
        route = findRoute(eng.graph, scoreOf, startNode, goalNode, relaxed, {
          inFlaggedArea: inFlagged,
        });
        if (route) break;
      }
      bestEffort = Boolean(route);
      if (route) {
        out.push({
          ...summarize(route, eng.scores, profile, eng.graph.nodes, baselineEntered, baselineMeters),
          label: `${profile.label} (best effort - could not clear every flagged area)`,
        });
        continue;
      }
    }

    if (route) {
      const summary = summarize(
        route,
        eng.scores,
        profile,
        eng.graph.nodes,
        baselineEntered,
        baselineMeters
      );
      if (id === "fastest") {
        baselineEntered = new Set(summary.neighborhoodsEntered.map((n) => n.name));
        baselineMeters = summary.distanceMeters;
      }
      out.push(summary);
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

  return order.map((id) => byProfile.get(id)).filter((r): r is RouteSummary => r != null);
}
