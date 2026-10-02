import { describe, expect, it } from "vitest";
import { getRoutingEngine, planRoutes } from "./service";

/**
 * Snapping an origin or destination onto the graph is not just "find the
 * nearest node". One-way geometry leaves stubs with in-degree or
 * out-degree zero, and landing on one makes the search unsolvable no
 * matter how well connected the rest of the city is.
 */
describe("origin/destination snapping", () => {
  const eng = getRoutingEngine();

  it("routes between two famous landmarks that previously failed", () => {
    // The node nearest Union Square has in-degree 0 - reachable only by
    // leaving it. This pair returned "No bike route found between these
    // points", which for two landmarks a mile apart is plainly a bug.
    const routes = planRoutes({ lat: 37.7955, lng: -122.3937 }, { lat: 37.788, lng: -122.4075 });
    expect(routes.length).toBe(3);
    expect(routes[0].distanceMeters).toBeGreaterThan(0);
  });

  it("the graph really does contain unusable stubs", () => {
    // Guards the premise. If this ever reads zero the fix above is no
    // longer doing anything and the test above would pass vacuously.
    let deadEnds = 0;
    let unreachable = 0;
    for (let i = 0; i < eng.graph.nodes.length; i++) {
      if (eng.outDegree[i] === 0) deadEnds++;
      if (eng.inDegree[i] === 0) unreachable++;
    }
    expect(deadEnds + unreachable).toBeGreaterThan(0);
  });

  it("never snaps an origin to a node that cannot be departed", () => {
    for (const p of [
      { lat: 37.7955, lng: -122.3937 },
      { lat: 37.788, lng: -122.4075 },
      { lat: 37.7562, lng: -122.5102 },
      { lat: 37.7544, lng: -122.4477 },
    ]) {
      const n = eng.index.nearest(p, 2000, (i) => eng.outDegree[i] > 0);
      expect(n).not.toBeNull();
      expect(eng.outDegree[n!]).toBeGreaterThan(0);
    }
  });

  it("never snaps a destination to a node that cannot be reached", () => {
    for (const p of [
      { lat: 37.7955, lng: -122.3937 },
      { lat: 37.788, lng: -122.4075 },
      { lat: 37.7299, lng: -122.3869 },
    ]) {
      const n = eng.index.nearest(p, 2000, (i) => eng.inDegree[i] > 0);
      expect(n).not.toBeNull();
      expect(eng.inDegree[n!]).toBeGreaterThan(0);
    }
  });

  it("routes between a spread of real SF landmark pairs", () => {
    const pts: [string, { lat: number; lng: number }][] = [
      ["Ocean Beach", { lat: 37.7562, lng: -122.5102 }],
      ["Ferry Building", { lat: 37.7955, lng: -122.3937 }],
      ["Twin Peaks", { lat: 37.7544, lng: -122.4477 }],
      ["Bayview", { lat: 37.7299, lng: -122.3869 }],
      ["Union Square", { lat: 37.788, lng: -122.4075 }],
      ["Golden Gate Park", { lat: 37.7694, lng: -122.4822 }],
    ];
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        expect(
          () => planRoutes(pts[i][1], pts[j][1]),
          `${pts[i][0]} -> ${pts[j][0]}`
        ).not.toThrow();
      }
    }
  });
});
