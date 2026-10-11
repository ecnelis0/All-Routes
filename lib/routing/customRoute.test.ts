import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_WAYPOINTS, planCustomRoute, planRoutes } from "./service";
import { distanceToPath } from "../ui/geometry";
import { cumulative } from "../nav/instructions";

// A west-side trip clear of every flagged area, so the profile's rules
// can be honoured on every leg.
const START = { lat: 37.806, lng: -122.441 }; // Marina Green
const END = { lat: 37.764, lng: -122.466 }; // Inner Sunset
// Two street corners off the direct line, in travel order.
const STOP_A = { lat: 37.7883, lng: -122.4466 }; // Sacramento & Presidio Ave
const STOP_B = { lat: 37.7728, lng: -122.4452 }; // Fell & Masonic
// Inside the Western Addition flagged area.
const ALAMO = { lat: 37.7764, lng: -122.4346 };

/** Distance along `path` of its closest approach to `p`. */
function alongOf(p: { lat: number; lng: number }, path: { lat: number; lng: number }[]): number {
  const cum = cumulative(path);
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < path.length; i++) {
    const d = distanceToPath(p, [path[i], path[Math.min(i + 1, path.length - 1)]]);
    if (d < best) {
      best = d;
      at = cum[i];
    }
  }
  return at;
}

describe("planCustomRoute (edited routes)", () => {
  it("with no stops, matches the normal route for that option", () => {
    const normal = planRoutes(START, END).find((r) => r.profile === "fastest")!;
    const custom = planCustomRoute(START, END, [], "fastest");
    expect(custom.distanceMeters).toBeCloseTo(normal.distanceMeters, 0);
  });

  it("passes through every stop, in the order given", () => {
    const r = planCustomRoute(START, END, [STOP_A, STOP_B], "balanced");
    // "Passes" a stop = within half the spur limit: a stop the route would
    // only touch by riding in and straight back out is passed by instead
    // (see pruneSpurs). It never undoes a stop that forces a street - that
    // is ridden through, not doubled back on.
    expect(distanceToPath(STOP_A, r.path)).toBeLessThan(150);
    expect(distanceToPath(STOP_B, r.path)).toBeLessThan(150);
    expect(alongOf(STOP_A, r.path)).toBeLessThan(alongOf(STOP_B, r.path));
    expect(r.label).toBe("My route (Safest)");
    expect(r.customWaypoints).toEqual([STOP_A, STOP_B]);
    expect(r.metersInFlaggedAreas).toBe(0);
  });

  it("detours to reach stops, so it is never shorter than the direct route", () => {
    const direct = planCustomRoute(START, END, [], "balanced");
    const edited = planCustomRoute(START, END, [STOP_B], "balanced");
    expect(edited.distanceMeters).toBeGreaterThanOrEqual(direct.distanceMeters - 1);
  });

  it("says so when a stop forces the route into a flagged area", () => {
    // A stop inside the Western Addition cannot be reached while avoiding
    // it; the route goes there, but must not claim to have avoided it.
    const r = planCustomRoute(START, END, [ALAMO], "balanced");
    expect(r.label).toBe("My route (Safest) · best effort");
    expect(r.metersInFlaggedAreas).toBeGreaterThan(0);
  });

  it("applies the hill and traffic-light choices to every leg", () => {
    const r = planCustomRoute(START, END, [STOP_A], "balanced", { avoidElevation: true, fewerSignals: true });
    expect(r.avoidedElevation).toBe(true);
    expect(r.preferredFewerSignals).toBe(true);
  });

  it("refuses too many stops", () => {
    const many = Array.from({ length: MAX_CUSTOM_WAYPOINTS + 1 }, () => ALAMO);
    expect(() => planCustomRoute(START, END, many, "fastest")).toThrow(/At most/);
  });
});

describe("stops on isolated paths", () => {
  it("snaps a stop dropped inside Golden Gate Park onto the connected network", () => {
    // Reproduced in the browser: dragging a stop here failed with "No bike
    // route found for leg 1" - it snapped to a park path with no way in.
    const IN_PARK = { lat: 37.767572637454236, lng: -122.47845151367187 };
    const r = planCustomRoute(START, END, [IN_PARK], "fastest");
    expect(distanceToPath(IN_PARK, r.path)).toBeLessThan(400);
  });

  it("almost the whole city is in the main network", async () => {
    const { getRoutingEngine } = await import("./service");
    const eng = getRoutingEngine();
    const share = eng.inMainNetwork.reduce((a, b) => a + b, 0) / eng.inMainNetwork.length;
    expect(share).toBeGreaterThan(0.9);
  });
});

import { pruneSpurs, SPUR_PRUNE_MAX_METERS, planCustomPath, getRoutingEngine } from "./service";
import type { GraphEdge } from "./graph";

describe("pointless out-and-backs to a stop", () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ lat: 37.7 + i * 0.001, lng: -122.4 }));
  const e = (from: number, to: number, len: number): GraphEdge => ({
    id: from * 100 + to,
    from,
    to,
    name: null,
    roadClass: "residential",
    tier: "none",
    lengthMeters: len,
    maxspeed: null,
  });
  const route = (edges: GraphEdge[]) => ({ edges, path: [], distanceMeters: edges.reduce((t, x) => t + x.lengthMeters, 0), costMeters: 0 });

  it("cuts a short ride-in-and-back, however many blocks deep", () => {
    // 0 -> 1 -> 2 -> 3 (stop) -> 2 -> 1 -> 4: the 1..3 spur is 2 x 60 m.
    const r = pruneSpurs(route([e(0, 1, 100), e(1, 2, 30), e(2, 3, 30), e(3, 2, 30), e(2, 1, 30), e(1, 4, 100)]), nodes);
    expect(r.edges.map((x) => `${x.from}>${x.to}`)).toEqual(["0>1", "1>4"]);
    expect(r.distanceMeters).toBe(200);
  });

  it("keeps a long one - then the place really is down a dead end", () => {
    const deep = SPUR_PRUNE_MAX_METERS; // one way, so the round trip is twice the limit
    const r = pruneSpurs(route([e(0, 1, 100), e(1, 2, deep), e(2, 1, deep), e(1, 4, 100)]), nodes);
    expect(r.edges).toHaveLength(4);
  });

  it("on the real network: a stop at Ocean Beach no longer detours into the sand and back", () => {
    // Reproduced from the owner's screenshot flow: Marina -> Stonestown on
    // Safest + bike lanes, then "add Ocean Beach" - the stop snapped onto a
    // beach path and the route rode 60 m in and back out.
    const A = { lat: 37.8029843, lng: -122.4374715 };
    const B = { lat: 37.7274507, lng: -122.4749029 };
    const OB = { lat: 37.7561513, lng: -122.510185 };
    const plan = planCustomPath(A, B, [OB], "safest", { avoidElevation: true, fewerSignals: true });
    const edges = plan.path.edges;
    for (let i = 1; i < edges.length; i++) {
      const uTurn = edges[i - 1].from === edges[i].to && edges[i - 1].to === edges[i].from;
      expect(uTurn, `U-turn at edge ${i}`).toBe(false);
    }
    // ...and still visits Ocean Beach.
    expect(distanceToPath(OB, plan.path.path)).toBeLessThan(SPUR_PRUNE_MAX_METERS / 2 + 50);
    expect(getRoutingEngine().graph.nodes.length).toBeGreaterThan(0);
  });
});
