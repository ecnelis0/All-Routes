import { describe, expect, it } from "vitest";
import { applySfmtaLaneTiers } from "./laneMatch";
import { REAL_SF_BIKE_LANES } from "../dataSources/sfmtaBikeLanes";
import { getRoutingEngine } from "../routing/service";
import type { GraphEdge } from "../routing/graph";
import type { BikeLaneSegment, LatLng } from "../types";

describe("applySfmtaLaneTiers", () => {
  // Two edges 400m apart; one sits on a protected facility, one nowhere near.
  function fixture() {
    const nodes: LatLng[] = [
      { lat: 37.77, lng: -122.42 },
      { lat: 37.7705, lng: -122.42 },
      { lat: 37.78, lng: -122.43 },
      { lat: 37.7805, lng: -122.43 },
    ];
    const edges: GraphEdge[] = [
      { id: 0, from: 0, to: 1, name: "On Facility", roadClass: "residential", tier: "none", lengthMeters: 55, maxspeed: null },
      { id: 1, from: 2, to: 3, name: "Far Away", roadClass: "residential", tier: "none", lengthMeters: 55, maxspeed: null },
    ];
    const lanes: BikeLaneSegment[] = [
      {
        id: "sfmta-1",
        name: "Protected Thing",
        tier: "fullyProtected",
        path: [
          { lat: 37.7698, lng: -122.42 },
          { lat: 37.7708, lng: -122.42 },
        ],
      },
    ];
    return { nodes, edges, lanes };
  }

  it("upgrades an edge sitting on a protected facility", () => {
    const { nodes, edges, lanes } = fixture();
    const stats = applySfmtaLaneTiers(edges, nodes, lanes);
    expect(edges[0].tier).toBe("fullyProtected");
    expect(stats.upgradedToProtected).toBe(1);
  });

  it("leaves edges with no nearby facility untouched", () => {
    const { nodes, edges, lanes } = fixture();
    applySfmtaLaneTiers(edges, nodes, lanes);
    // OSM's tag is kept where SFMTA has no coverage - the graph extends
    // past the surveyed network and includes paths SFMTA does not catalogue.
    expect(edges[1].tier).toBe("none");
  });

  it("does not match a facility further than the tolerance", () => {
    const { nodes, edges } = fixture();
    const farLane: BikeLaneSegment[] = [
      {
        id: "sfmta-far",
        name: "A block over",
        tier: "fullyProtected",
        // ~90m east of the edge: a different street, and matching it would
        // credit this edge with a lane it does not have.
        path: [
          { lat: 37.7698, lng: -122.419 },
          { lat: 37.7708, lng: -122.419 },
        ],
      },
    ];
    const stats = applySfmtaLaneTiers(edges, nodes, farLane);
    expect(stats.matched).toBe(0);
    expect(edges[0].tier).toBe("none");
  });

  it("takes the most protective facility when several are in range", () => {
    const { nodes, edges } = fixture();
    const both: BikeLaneSegment[] = [
      { id: "a", name: "painted", tier: "unprotected", path: [{ lat: 37.7698, lng: -122.42 }, { lat: 37.7708, lng: -122.42 }] },
      { id: "b", name: "protected", tier: "fullyProtected", path: [{ lat: 37.7698, lng: -122.4201 }, { lat: 37.7708, lng: -122.4201 }] },
    ];
    applySfmtaLaneTiers(edges, nodes, both);
    expect(edges[0].tier).toBe("fullyProtected");
  });

  it("can downgrade, not only upgrade", () => {
    // OSM optimism is as wrong as OSM omission; SFMTA wins either way.
    const { nodes, edges } = fixture();
    edges[0].tier = "fullyProtected";
    const painted: BikeLaneSegment[] = [
      { id: "a", name: "painted", tier: "unprotected", path: [{ lat: 37.7698, lng: -122.42 }, { lat: 37.7708, lng: -122.42 }] },
    ];
    const stats = applySfmtaLaneTiers(edges, nodes, painted);
    expect(edges[0].tier).toBe("unprotected");
    expect(stats.changed).toBe(1);
    expect(stats.upgradedToProtected).toBe(0);
  });
});

describe("the real graph after reconciliation", () => {
  const eng = getRoutingEngine();

  it("actually ran, and corrected a substantial share of tiers", () => {
    // Measured: 57,542 of 211,221 edges matched an SFMTA facility, 32,128
    // tiers changed, 16,811 upgraded to protected. Floors well below those
    // so ordinary data refreshes do not trip the test.
    expect(eng.laneMatch.matched).toBeGreaterThan(30_000);
    expect(eng.laneMatch.changed).toBeGreaterThan(10_000);
    expect(eng.laneMatch.upgradedToProtected).toBeGreaterThan(5_000);
  });

  it("fixes the implausible shortage of semi-protected lanes", () => {
    // Inferring buffered lanes from OSM tags yielded 89 semi-protected
    // edges city-wide against SFMTA's 274 buffered facilities - a tell
    // that the tag heuristic was far too narrow.
    const semi = eng.graph.edges.filter((e) => e.tier === "semiProtected").length;
    expect(semi).toBeGreaterThan(1000);
  });

  it("agrees with SFMTA on tiers wherever SFMTA has coverage", () => {
    // The point of the whole exercise: after reconciliation, a second pass
    // should find nothing left to change.
    const copy = eng.graph.edges.map((e) => ({ ...e }));
    const second = applySfmtaLaneTiers(copy, eng.graph.nodes, REAL_SF_BIKE_LANES);
    expect(second.changed).toBe(0);
  });
});
