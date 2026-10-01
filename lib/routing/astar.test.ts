import { describe, expect, it } from "vitest";
import { findRoute } from "./astar";
import { ROUTE_PROFILES, edgeCost, type RouteProfile } from "./cost";
import type { BikeGraph, GraphEdge } from "./graph";
import type { LatLng } from "../types";

/**
 * A deliberately tiny, hand-built graph: two parallel west-east corridors
 * between the same endpoints.
 *
 *   start(0) --- a(1) --- a(2) --- end(3)      "north": short, dangerous
 *      \                            /
 *       b(4) --- b(5) --- b(6) ----              "south": longer, safe
 *
 * Everything about safety routing is a trade between those two, so a graph
 * with exactly two options makes the expected answer something you can
 * reason about rather than measure.
 */
function buildTestGraph(): BikeGraph {
  const nodes: LatLng[] = [
    { lat: 37.77, lng: -122.42 }, // 0 start
    { lat: 37.77, lng: -122.418 }, // 1
    { lat: 37.77, lng: -122.416 }, // 2
    { lat: 37.77, lng: -122.414 }, // 3 end
    { lat: 37.768, lng: -122.4187 }, // 4
    { lat: 37.768, lng: -122.4167 }, // 5
    { lat: 37.768, lng: -122.4147 }, // 6
  ];

  const spec: [number, number, number][] = [
    // north corridor: 3 hops of ~175m
    [0, 1, 175],
    [1, 2, 175],
    [2, 3, 175],
    // south corridor: longer detour
    [0, 4, 240],
    [4, 5, 180],
    [5, 6, 180],
    [6, 3, 240],
  ];

  const edges: GraphEdge[] = [];
  const adjacency: number[][] = Array.from({ length: nodes.length }, () => []);
  for (const [from, to, len] of spec) {
    for (const [a, b] of [
      [from, to],
      [to, from],
    ]) {
      const id = edges.length;
      edges.push({
        id,
        from: a,
        to: b,
        name: null,
        roadClass: "residential",
        tier: "none",
        lengthMeters: len,
        maxspeed: null,
      });
      adjacency[a].push(id);
    }
  }

  return {
    nodes,
    edges,
    adjacency,
    bounds: { north: 37.78, south: 37.76, east: -122.41, west: -122.43 },
    generatedAt: "test",
  };
}

const NORTH_NODES = new Set([1, 2]);
const SOUTH_NODES = new Set([4, 5, 6]);

/** 90 on the north corridor, 10 on the south. */
function dangerousNorth(graph: BikeGraph) {
  return (edgeId: number) => {
    const e = graph.edges[edgeId];
    const onNorth = NORTH_NODES.has(e.from) || NORTH_NODES.has(e.to);
    return onNorth ? 90 : 10;
  };
}

function usesSouth(graph: BikeGraph, edges: GraphEdge[]) {
  return edges.some((e) => SOUTH_NODES.has(e.from) || SOUTH_NODES.has(e.to));
}

describe("findRoute", () => {
  const graph = buildTestGraph();

  it("takes the shortest path when the profile ignores danger", () => {
    const r = findRoute(graph, dangerousNorth(graph), 0, 3, ROUTE_PROFILES.fastest);
    expect(r).not.toBeNull();
    expect(r!.distanceMeters).toBe(525); // 3 x 175, the north corridor
    expect(usesSouth(graph, r!.edges)).toBe(false);
  });

  it("takes the longer, safer corridor when danger is weighted", () => {
    const r = findRoute(graph, dangerousNorth(graph), 0, 3, ROUTE_PROFILES.safest);
    expect(r).not.toBeNull();
    expect(usesSouth(graph, r!.edges)).toBe(true);
    expect(r!.distanceMeters).toBe(840);
  });

  it("prefers the safer corridor on danger WEIGHT alone, with no hard-avoid in play", () => {
    // Deliberately below every profile's hard-avoid ceiling, so the only
    // thing that can steer the router is the cost weighting. Without this,
    // the test above passes even if safetyWeight is zero - the ceiling
    // alone would exclude the north corridor, and the two mechanisms would
    // be indistinguishable.
    const scoreOf = (edgeId: number) => {
      const e = graph.edges[edgeId];
      return NORTH_NODES.has(e.from) || NORTH_NODES.has(e.to) ? 70 : 5;
    };
    for (const profile of [ROUTE_PROFILES.balanced, ROUTE_PROFILES.safest]) {
      const r = findRoute(graph, scoreOf, 0, 3, profile)!;
      expect(r.edges.every((e) => scoreOf(e.id) < profile.hardAvoidScore)).toBe(true);
      expect(usesSouth(graph, r.edges)).toBe(true);
    }
    // ...and the indifferent profile still takes the short dangerous one.
    const fast = findRoute(graph, scoreOf, 0, 3, ROUTE_PROFILES.fastest)!;
    expect(usesSouth(graph, fast.edges)).toBe(false);
  });

  it("refuses edges at or above the profile's hard-avoid score", () => {
    // Everything scores 95; `safest` hard-avoids at 75, so nothing is
    // passable and the router must return null rather than route anyway.
    const r = findRoute(graph, () => 95, 0, 3, ROUTE_PROFILES.safest);
    expect(r).toBeNull();
  });

  it("still routes when a hard-avoided edge has a legal alternative", () => {
    // Only the north corridor is above the ceiling.
    const r = findRoute(graph, dangerousNorth(graph), 0, 3, ROUTE_PROFILES.safest);
    expect(r).not.toBeNull();
    expect(r!.edges.every((e) => dangerousNorth(graph)(e.id) < 75)).toBe(true);
  });

  it("returns null when the goal is unreachable", () => {
    const isolated: BikeGraph = {
      ...graph,
      nodes: [...graph.nodes, { lat: 37.9, lng: -122.9 }],
      adjacency: [...graph.adjacency, []],
    };
    expect(findRoute(isolated, () => 0, 0, 7, ROUTE_PROFILES.fastest)).toBeNull();
  });

  it("reports cost separately from distance, inflated by danger", () => {
    const r = findRoute(graph, () => 50, 0, 3, ROUTE_PROFILES.balanced)!;
    // safetyWeight 1.5 at score 50 => every metre costs 1.75 effective metres.
    expect(r.costMeters).toBeCloseTo(r.distanceMeters * 1.75, 5);
    expect(r.costMeters).toBeGreaterThan(r.distanceMeters);
  });

  it("builds path geometry that starts at the origin and ends at the goal", () => {
    const r = findRoute(graph, () => 0, 0, 3, ROUTE_PROFILES.fastest)!;
    expect(r.path[0]).toEqual(graph.nodes[0]);
    expect(r.path[r.path.length - 1]).toEqual(graph.nodes[3]);
    expect(r.path).toHaveLength(r.edges.length + 1);
  });

  it("finds the genuinely optimal path, not merely a good one", () => {
    // A* is only optimal while the heuristic never overestimates. This
    // compares its answer against an exhaustive Dijkstra over the same
    // costs, which is the property that actually matters and the one a
    // bad heuristic would silently break.
    const profile = ROUTE_PROFILES.balanced;
    const scoreOf = dangerousNorth(graph);
    const best = dijkstraCost(graph, scoreOf, 0, 3, profile);
    const r = findRoute(graph, scoreOf, 0, 3, profile)!;
    expect(r.costMeters).toBeCloseTo(best, 6);
  });
});

/** Reference implementation with no heuristic - slow, obviously correct. */
function dijkstraCost(
  graph: BikeGraph,
  scoreOf: (id: number) => number,
  start: number,
  goal: number,
  profile: RouteProfile
): number {
  const dist = new Array(graph.nodes.length).fill(Infinity);
  dist[start] = 0;
  const seen = new Set<number>();
  for (;;) {
    let u = -1;
    let bestD = Infinity;
    for (let i = 0; i < dist.length; i++) {
      if (!seen.has(i) && dist[i] < bestD) {
        bestD = dist[i];
        u = i;
      }
    }
    if (u === -1) break;
    seen.add(u);
    for (const id of graph.adjacency[u]) {
      const e = graph.edges[id];
      const c = edgeCost(e, scoreOf(id), profile);
      if (!Number.isFinite(c)) continue;
      if (dist[u] + c < dist[e.to]) dist[e.to] = dist[u] + c;
    }
  }
  return dist[goal];
}

describe("edgeCost", () => {
  const edge: GraphEdge = {
    id: 0,
    from: 0,
    to: 1,
    name: null,
    roadClass: "residential",
    tier: "none",
    lengthMeters: 100,
    maxspeed: null,
  };

  it("charges exactly the length when the profile ignores danger", () => {
    expect(edgeCost(edge, 100, ROUTE_PROFILES.fastest)).toBe(100);
  });

  it("scales with length, so splitting a street does not change its total cost", () => {
    // The reason cost is multiplicative on length rather than a flat
    // per-edge penalty: OSM splits streets arbitrarily, and a flat penalty
    // would punish a finely-split street for nothing.
    const whole = edgeCost({ ...edge, lengthMeters: 300 }, 60, ROUTE_PROFILES.balanced);
    const thirds =
      3 * edgeCost({ ...edge, lengthMeters: 100 }, 60, ROUTE_PROFILES.balanced);
    expect(whole).toBeCloseTo(thirds, 9);
  });

  it("never returns less than the edge's true length (A* admissibility)", () => {
    // findRoute's straight-line heuristic is admissible only under this
    // property. A "bonus" for good streets would break optimality silently.
    for (const profile of Object.values(ROUTE_PROFILES)) {
      for (const score of [0, 1, 25, 50, 74]) {
        const c = edgeCost(edge, score, profile);
        if (Number.isFinite(c)) expect(c).toBeGreaterThanOrEqual(edge.lengthMeters);
      }
    }
  });
});
