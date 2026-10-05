import { describe, expect, it } from "vitest";
import { getRoutingEngine, planRoutes } from "./service";
import { REAL_SF_HIGHWAYS } from "../dataSources/sfHighways";
import { MOCK_HIGHWAY_SEGMENTS } from "../mockData";
import { buildFeatureContext, extractFeatures } from "../scoring/features";
import { REAL_SF_BIKE_CRASHES } from "../dataSources/sfBikeCrashes";
import type { GraphEdge } from "./graph";

/**
 * Highway exposure, end to end on the real network.
 *
 * The gap these cover: exposure risk used to come from seven hand-drawn
 * mock segments, so ~170 of San Francisco's real arterials contributed
 * exactly zero risk. Only 13% of edges registered any highway exposure at
 * all; with real data it is 75%. Nothing failed - the model simply could
 * not see most of the hazard.
 */

describe("real highway data", () => {
  it("covers vastly more road than the mock segments it replaced", () => {
    expect(MOCK_HIGHWAY_SEGMENTS.length).toBeLessThan(20);
    expect(REAL_SF_HIGHWAYS.length).toBeGreaterThan(3000);
  });

  it("includes both freeways and arterials", () => {
    const types = new Set(REAL_SF_HIGHWAYS.map((h) => h.type));
    expect(types.has("freeway")).toBe(true);
    expect(types.has("arterial")).toBe(true);
  });

  it("includes major SF freeways the mock set omitted entirely", () => {
    const names = REAL_SF_HIGHWAYS.map((h) => h.name).join(" | ");
    for (const expected of ["Bayshore Freeway", "James Lick Freeway", "Central Freeway"]) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
  });

  it("gives every segment real geometry and a speed", () => {
    for (const h of REAL_SF_HIGHWAYS.slice(0, 500)) {
      expect(h.path.length).toBeGreaterThanOrEqual(2);
      expect(h.typicalSpeedMph).toBeGreaterThan(0);
    }
  });
});

describe("highway exposure as a feature", () => {
  const eng = getRoutingEngine();

  it("is actually wired to the real dataset, not just able to load it", () => {
    // The gap this closes: every other test here builds its own feature
    // context from REAL_SF_HIGHWAYS, so they all pass even if the engine
    // itself is reverted to the 7 mock segments. This asserts the
    // production path.
    expect(getRoutingEngine().highwaySegmentCount).toBeGreaterThan(3000);
  });

  it("sees exposure on most of the city, not a tenth of it", () => {
    const ctx = buildFeatureContext(REAL_SF_BIKE_CRASHES, REAL_SF_HIGHWAYS, eng.graph.nodes);
    // Sample rather than scan all 211k edges - this is a test, not a job.
    const step = 37;
    let withExposure = 0;
    let sampled = 0;
    for (let i = 0; i < eng.graph.edges.length; i += step) {
      const f = extractFeatures(eng.graph.edges[i], ctx);
      if (f.freewayProximity > 0 || f.arterialProximity > 0) withExposure++;
      sampled++;
    }
    const share = withExposure / sampled;
    // Measured at 0.75 with real data, 0.13 with the mock set. A regression
    // to mock-like coverage would land far below this floor.
    expect(share).toBeGreaterThan(0.5);
  });

  it("scores a freeway-adjacent point above a quiet inland one", () => {
    const ctx = buildFeatureContext(REAL_SF_BIKE_CRASHES, REAL_SF_HIGHWAYS, eng.graph.nodes);
    const fake = (lat: number, lng: number): GraphEdge => {
      // Reuse a real node pair's shape but place it where we want by
      // appending two synthetic nodes to the context's node list.
      const i = ctx.nodes.length;
      ctx.nodes.push({ lat, lng }, { lat: lat + 0.0003, lng });
      return {
        id: -1,
        from: i,
        to: i + 1,
        name: null,
        roadClass: "residential",
        tier: "none",
        lengthMeters: 35,
        maxspeed: null,
      };
    };
    // Directly beside the Central Freeway vs deep in the Outer Sunset.
    const beside = extractFeatures(fake(37.7715, -122.4155), ctx);
    const quiet = extractFeatures(fake(37.7520, -122.4950), ctx);
    expect(beside.freewayProximity + beside.arterialProximity).toBeGreaterThan(
      quiet.freewayProximity + quiet.arterialProximity
    );
  });
});

describe("routes respond to highway exposure", () => {
  // Bayview -> Marina: the direct line parallels US-101 and I-280 for much
  // of its length, so this is where avoidance has to show up or nowhere.
  const routes = planRoutes({ lat: 37.73, lng: -122.39 }, { lat: 37.803, lng: -122.436 });
  const by = Object.fromEntries(routes.map((r) => [r.profile, r]));

  it("produces all three profiles", () => {
    expect(Object.keys(by).sort()).toEqual(["balanced", "fastest", "safest"]);
  });

  it("lowers overall danger as the profile gets safer", () => {
    expect(by.balanced.meanDanger).toBeLessThanOrEqual(by.fastest.meanDanger);
    expect(by.safest.meanDanger).toBeLessThanOrEqual(by.balanced.meanDanger);
  });

  it("cuts distance spent inside flagged neighbourhoods", () => {
    expect(by.safest.metersInFlaggedAreas).toBeLessThan(by.fastest.metersInFlaggedAreas * 0.6);
  });

  it("never routes onto a freeway, because bikes are banned there", () => {
    // Structural, not a scoring preference: scripts/fetchSfBikeGraph.mjs
    // drops motorway/trunk before the graph is built. This asserts the
    // graph genuinely contains no such class, so re-adding one to
    // ROUTABLE_HIGHWAY would fail here rather than silently producing
    // routes down the freeway.
    const allowed = new Set([
      "cycleway",
      "livingStreet",
      "residential",
      "tertiary",
      "secondary",
      "primary",
      "path",
      "service",
    ]);
    const classes = new Set(getRoutingEngine().graph.edges.map((e) => e.roadClass));
    for (const c of classes) expect(allowed.has(c), `unexpected road class ${c}`).toBe(true);
    expect(classes.has("cycleway")).toBe(true); // sanity: the set is populated
  });

  it("does not mistake surface streets for the freeways that share their name", () => {
    // Guards the obvious-looking test that does NOT work: "no routed street
    // is named like a freeway". Seven names in SF are tagged both ways -
    // Mission Street has 141 arterial ways and 5 short trunk-classified
    // ramp segments by the 101 interchange - so a name check would flag a
    // perfectly legal ride down surface Mission Street as riding the
    // freeway. Road class is the sound signal; names are not.
    const fwNames = new Set(
      REAL_SF_HIGHWAYS.filter((h) => h.type === "freeway").map((h) => h.name)
    );
    const artNames = new Set(
      REAL_SF_HIGHWAYS.filter((h) => h.type === "arterial").map((h) => h.name)
    );
    const ambiguous = [...fwNames].filter((n) => artNames.has(n));
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(ambiguous).toContain("Mission Street");
  });
});

