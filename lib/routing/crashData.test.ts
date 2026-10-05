import { describe, expect, it } from "vitest";
import { getRoutingEngine } from "./service";
import { REAL_SF_BIKE_CRASHES } from "../dataSources/sfBikeCrashes";
import { buildFeatureContext, extractFeatures } from "../scoring/features";
import { REAL_SF_HIGHWAYS } from "../dataSources/sfHighways";

/**
 * The router used to score streets against randomly generated mock
 * crashes. These pin the production path to the real DataSF records.
 */
describe("real crash data", () => {
  it("the engine scores against real DataSF bicycle crashes, not mock data", () => {
    const eng = getRoutingEngine();
    expect(eng.crashSource).toBe("city-open-data");
    // 3,558 at import (2019 onward); the mock set was 349.
    expect(eng.crashCount).toBeGreaterThan(3000);
  });

  it("every record is inside San Francisco and has a severity", () => {
    for (const c of REAL_SF_BIKE_CRASHES) {
      expect(c.position.lat).toBeGreaterThan(37.7);
      expect(c.position.lat).toBeLessThan(37.84);
      expect(c.position.lng).toBeGreaterThan(-122.52);
      expect(c.position.lng).toBeLessThan(-122.35);
      expect([1, 2, 3]).toContain(c.severity);
    }
  });

  it("Market Street - the city's top bike-crash corridor - carries crash weight", () => {
    const eng = getRoutingEngine();
    const ctx = buildFeatureContext(REAL_SF_BIKE_CRASHES, REAL_SF_HIGHWAYS, eng.graph.nodes);
    const mean = (name: string) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < eng.graph.edges.length; i += 7) {
        const e = eng.graph.edges[i];
        if (e.name !== name) continue;
        sum += extractFeatures(e, ctx).crashDensity;
        n++;
      }
      return sum / n;
    };
    // A quiet residential street for contrast.
    expect(mean("Market Street")).toBeGreaterThan(3 * mean("Clement Street"));
  });
});
