import type { LatLng } from "../types";
import { approxMeters, type BikeGraph, type GraphEdge } from "./graph";
import { edgeCost, type RouteProfile } from "./cost";

/** Binary min-heap. A sorted-array frontier is O(n) per pop and dominates runtime on a 120k-edge graph. */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, key: number) {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

export interface RoutePath {
  /** Node-by-node geometry, ready to draw. */
  path: LatLng[];
  /** Edges traversed, in order - the basis for every statistic we report. */
  edges: GraphEdge[];
  distanceMeters: number;
  /** Sum of `edgeCost`, i.e. distance already inflated by danger. */
  costMeters: number;
}

/**
 * A* over the bike graph.
 *
 * The heuristic is straight-line distance to the target, which is
 * admissible only because `edgeCost` never returns less than an edge's
 * true length (`safetyWeight` and `score` are both non-negative, so the
 * multiplier is >= 1). If a future profile ever *rewards* an edge with a
 * cost below its length - a bonus for protected lanes, say - this
 * heuristic stops being admissible and A* may return a non-optimal path.
 * Express preferences as smaller penalties, not negative ones.
 */
export function findRoute(
  graph: BikeGraph,
  scoreOf: (edgeId: number) => number,
  startNode: number,
  goalNode: number,
  profile: RouteProfile,
  opts: { maxExpansions?: number } = {}
): RoutePath | null {
  const maxExpansions = opts.maxExpansions ?? 400_000;
  const n = graph.nodes.length;
  const goal = graph.nodes[goalNode];

  const gScore = new Float64Array(n).fill(Infinity);
  const cameFromEdge = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  gScore[startNode] = 0;
  const open = new MinHeap();
  open.push(startNode, approxMeters(graph.nodes[startNode], goal));

  let expansions = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    if (current === goalNode)
      return reconstruct(graph, cameFromEdge, startNode, goalNode, gScore[goalNode]);
    closed[current] = 1;

    if (++expansions > maxExpansions) break;

    for (const edgeId of graph.adjacency[current]) {
      const edge = graph.edges[edgeId];
      if (closed[edge.to]) continue;

      const cost = edgeCost(edge, scoreOf(edgeId), profile);
      // Pure optimization, not a correctness guard: an Infinite cost makes
      // `tentative` Infinite, and `Infinity < Infinity` is already false, so
      // the relaxation below would reject the edge anyway.
      if (!Number.isFinite(cost)) continue; // hard-avoided

      const tentative = gScore[current] + cost;
      if (tentative < gScore[edge.to]) {
        gScore[edge.to] = tentative;
        cameFromEdge[edge.to] = edgeId;
        open.push(edge.to, tentative + approxMeters(graph.nodes[edge.to], goal));
      }
    }
  }

  return null;
}

function reconstruct(
  graph: BikeGraph,
  cameFromEdge: Int32Array,
  startNode: number,
  goalNode: number,
  costMeters: number
): RoutePath {
  const edges: GraphEdge[] = [];
  let node = goalNode;
  while (node !== startNode) {
    const edgeId = cameFromEdge[node];
    if (edgeId < 0) break;
    const edge = graph.edges[edgeId];
    edges.push(edge);
    node = edge.from;
  }
  edges.reverse();

  const path: LatLng[] = [graph.nodes[startNode]];
  let distanceMeters = 0;
  for (const e of edges) {
    path.push(graph.nodes[e.to]);
    distanceMeters += e.lengthMeters;
  }

  return { path, edges, distanceMeters, costMeters };
}
