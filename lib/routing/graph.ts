import type { BikeLaneTier, LatLng } from "../types";

/**
 * A directed, routable edge between two graph nodes - one block of one
 * street, in one direction of travel. `lib/routing/astar.ts` walks these;
 * `lib/scoring/` decides what each one costs.
 *
 * Note the split between what this type carries and what it does *not*:
 * everything here is an observable fact about the street (how long, what
 * class, what cycling infrastructure is tagged on it). There is deliberately
 * no safety score on this type - that is the model's output, held separately
 * in a `SafetyScores` table keyed by `id`, so retraining the model never
 * means regenerating the graph.
 */
export interface GraphEdge {
  /** Dense index into the edge arrays - also the key into the model's score table. */
  id: number;
  from: number;
  to: number;
  name: string | null;
  roadClass: RoadClass;
  tier: BikeLaneTier;
  lengthMeters: number;
  /** Posted speed in mph where OSM knows it, else null. */
  maxspeed: number | null;
}

export type RoadClass =
  | "cycleway"
  | "livingStreet"
  | "residential"
  | "tertiary"
  | "secondary"
  | "primary"
  | "path"
  | "service";

export interface BikeGraph {
  nodes: LatLng[];
  edges: GraphEdge[];
  /** `adjacency[nodeIndex]` = ids of edges leaving that node. */
  adjacency: number[][];
  bounds: { north: number; south: number; east: number; west: number };
  generatedAt: string;
}

/** The on-disk columnar shape written by `scripts/fetchSfBikeGraph.mjs`. */
interface ColumnarGraph {
  format: string;
  generatedAt: string;
  bounds: { north: number; south: number; east: number; west: number };
  roadClasses: string[];
  tiers: string[];
  names: string[];
  nodeCount: number;
  edgeCount: number;
  lat: number[];
  lng: number[];
  from: number[];
  to: number[];
  roadClass: number[];
  tier: number[];
  name: number[];
  oneway: number[];
  maxspeed: number[];
  lengthMeters: number[];
}

/**
 * Decodes the columnar on-disk graph into objects and builds the adjacency
 * list. Two-way streets become two directed edges; one-way streets become
 * one. Done once per process (see `getBikeGraph`), not per request - on a
 * ~120k-edge graph this is the difference between a one-off ~1s cost and a
 * ~1s cost on every route.
 */
export function decodeGraph(raw: ColumnarGraph): BikeGraph {
  if (raw.format !== "columnar-v1") {
    throw new Error(
      `Unsupported bike-graph format "${raw.format}" (expected "columnar-v1"). ` +
        `Re-run scripts/fetchSfBikeGraph.mjs.`
    );
  }

  const nodes: LatLng[] = new Array(raw.nodeCount);
  for (let i = 0; i < raw.nodeCount; i++) nodes[i] = { lat: raw.lat[i], lng: raw.lng[i] };

  const edges: GraphEdge[] = [];
  const adjacency: number[][] = Array.from({ length: raw.nodeCount }, () => []);

  const pushEdge = (from: number, to: number, i: number) => {
    const id = edges.length;
    edges.push({
      id,
      from,
      to,
      name: raw.name[i] === -1 ? null : raw.names[raw.name[i]],
      roadClass: raw.roadClasses[raw.roadClass[i]] as RoadClass,
      tier: raw.tiers[raw.tier[i]] as BikeLaneTier,
      lengthMeters: raw.lengthMeters[i],
      maxspeed: raw.maxspeed[i] === 0 ? null : raw.maxspeed[i],
    });
    adjacency[from].push(id);
  };

  for (let i = 0; i < raw.edgeCount; i++) {
    pushEdge(raw.from[i], raw.to[i], i);
    if (raw.oneway[i] === 0) pushEdge(raw.to[i], raw.from[i], i);
  }

  return { nodes, edges, adjacency, bounds: raw.bounds, generatedAt: raw.generatedAt };
}

/**
 * A uniform grid over the city for "which graph node is nearest this
 * point?" - needed to snap a user's typed origin/destination onto the
 * network before routing. A linear scan of 112k nodes per lookup is fast
 * enough in isolation but not when it happens on every request alongside
 * everything else; bucketing makes it effectively constant-time.
 */
export class NodeSpatialIndex {
  private buckets = new Map<string, number[]>();
  private readonly cell = 0.003; // ~330m in latitude

  constructor(private nodes: LatLng[]) {
    for (let i = 0; i < nodes.length; i++) {
      const k = this.key(nodes[i]);
      const b = this.buckets.get(k);
      if (b) b.push(i);
      else this.buckets.set(k, [i]);
    }
  }

  private key(p: LatLng): string {
    return `${Math.floor(p.lat / this.cell)},${Math.floor(p.lng / this.cell)}`;
  }

  /**
   * Nearest node index to `point`, or null if nothing is within
   * `maxMeters`. Searches outward in rings so a point in an empty bucket
   * (common - the user drops a pin mid-park or offshore) still resolves
   * instead of failing.
   */
  nearest(point: LatLng, maxMeters = 2000): number | null {
    const r0 = Math.floor(point.lat / this.cell);
    const c0 = Math.floor(point.lng / this.cell);
    let best = -1;
    let bestD = Infinity;

    for (let ring = 0; ring <= 8; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          // Only the outer shell of each ring is new.
          if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
          const b = this.buckets.get(`${r0 + dr},${c0 + dc}`);
          if (!b) continue;
          for (const i of b) {
            const d = approxMeters(point, this.nodes[i]);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Once a ring has produced a hit closer than the ring's own inner
      // radius, no further ring can beat it.
      if (best !== -1 && bestD < ring * this.cell * 111_320) break;
    }

    return best !== -1 && bestD <= maxMeters ? best : null;
  }
}

/** Fast planar distance - at city scale the error vs haversine is under a metre. */
export function approxMeters(a: LatLng, b: LatLng): number {
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (a.lat - b.lat) * mPerLat;
  const dx = (a.lng - b.lng) * mPerLng;
  return Math.sqrt(dx * dx + dy * dy);
}
