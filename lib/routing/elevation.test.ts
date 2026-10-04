import { describe, expect, it } from "vitest";
import { getRoutingEngine, planRoutes } from "./service";
import elevation from "../data/sfNodeElevation.json";
import { SF_STEEP_STREETS, STEEP_GRADE_THRESHOLD } from "../data/sfSteepAreas";

const eng = getRoutingEngine();

describe("elevation data", () => {
  it("is aligned to the graph it was sampled from", () => {
    // Heights are per node INDEX. A regenerated graph renumbers nodes, so
    // stale heights would pair streets with the wrong elevation - the
    // engine refuses to start in that case, and this pins the premise.
    expect(elevation.nodeCount).toBe(eng.graph.nodes.length);
    expect(elevation.graphGeneratedAt).toBe(eng.graph.generatedAt);
  });

  it("matches real San Francisco topography", () => {
    // Twin Peaks summit is ~282m; nothing in the city is below sea level.
    // Reduced with a loop: spreading 112k values into Math.max overflows
    // the call stack.
    let max = -Infinity;
    let min = Infinity;
    for (const v of elevation.elevDm) {
      if (v > max) max = v;
      if (v < min) min = v;
    }
    expect(max / 10).toBeGreaterThan(260);
    expect(max / 10).toBeLessThan(300);
    expect(min).toBeGreaterThanOrEqual(0);
  });

  it("does not sample the bay floor under bridge decks", () => {
    // 75 nodes on the Bay Bridge Trail and Golden Gate Bridge sidewalks
    // originally read down to -98.8m - the DEM is ground, and over water
    // ground is the seabed. A router would see a 99m plunge into the bay.
    for (const v of elevation.elevDm) expect(v).toBeGreaterThanOrEqual(0);
  });
});

/** Grades of a named street's edges over 25m, from the engine's own climb data. */
function grades(name: string): number[] {
  const out: number[] = [];
  for (const e of eng.graph.edges) {
    if (e.name !== name || e.lengthMeters < 25) continue;
    out.push(Math.abs(eng.climbMeters[e.id]) / e.lengthMeters);
  }
  return out.sort((a, b) => a - b);
}
const share = (g: number[], t: number) => g.filter((x) => x > t).length / Math.max(1, g.length);

describe("the owner's steep list, checked against terrain", () => {
  it("finds the listed extreme streets genuinely steep", () => {
    // Filbert and 22nd are famously ~31.5% at their worst.
    expect(Math.max(...grades("Filbert Street"))).toBeGreaterThan(0.25);
    expect(Math.max(...grades("22nd Street"))).toBeGreaterThan(0.25);
    expect(share(grades("Bradford Street"), 0.08)).toBeGreaterThan(0.8);
  });

  it("finds flat control streets flat", () => {
    expect(share(grades("Valencia Street"), 0.08)).toBe(0);
  });

  it("shows why names are the wrong unit: 24th Street is mostly flat", () => {
    // Steep in Noe Valley, flat through the Mission. Penalising by name
    // would push riders off the flat majority of it.
    const g = grades("24th Street");
    expect(g[g.length >> 1]).toBeLessThan(0.04);
    expect(share(g, 0.08)).toBeLessThan(0.4);
  });

  it("only applies list severity to blocks that are actually steep", () => {
    for (const e of eng.graph.edges) {
      const sev = eng.steepSeverity[e.id];
      if (!sev) continue;
      const climb = eng.climbMeters[e.id];
      expect(climb).toBeGreaterThan(0);
      // Small tolerance: climbs are stored as Float32, so a block computed
      // at exactly the 6% threshold reads back as 5.9999998%.
      expect(climb / Math.max(e.lengthMeters, 15)).toBeGreaterThanOrEqual(
        STEEP_GRADE_THRESHOLD - 1e-6
      );
    }
  });

  it("never flags the flat Mission stretch of a listed street", () => {
    expect(SF_STEEP_STREETS["24th Street"]).toBe("Extreme");
    for (const e of eng.graph.edges) {
      if (e.name !== "24th Street") continue;
      const grade = Math.abs(eng.climbMeters[e.id]) / Math.max(e.lengthMeters, 15);
      if (grade < 0.02) expect(eng.steepSeverity[e.id]).toBeNull();
    }
  });
});

describe("avoid elevation", () => {
  it("routes the safest profile around Jones Street on Marina -> Union Square", () => {
    // Without it the safety model sent a cyclist up 625m of Jones Street at
    // a 27.5% max grade, because the street is quiet. Low danger is not
    // the same as rideable.
    const A = { lat: 37.803, lng: -122.436 };
    const B = { lat: 37.788, lng: -122.4075 };
    const off = planRoutes(A, B).find((r) => r.profile === "safest")!;
    const on = planRoutes(A, B, { avoidElevation: true }).find((r) => r.profile === "safest")!;
    expect(on.maxGradePercent).toBeLessThan(off.maxGradePercent);
    expect(on.elevationGainMeters).toBeLessThan(off.elevationGainMeters);
    expect(on.maxGradePercent).toBeLessThan(15);
  });

  it("reduces climbing on average across hilly trips without huge detours", () => {
    const trips = [
      [{ lat: 37.7599, lng: -122.4148 }, { lat: 37.734, lng: -122.434 }],
      [{ lat: 37.803, lng: -122.436 }, { lat: 37.788, lng: -122.4075 }],
      [{ lat: 37.7609, lng: -122.435 }, { lat: 37.7576, lng: -122.4004 }],
      [{ lat: 37.7562, lng: -122.5102 }, { lat: 37.7955, lng: -122.3937 }],
    ] as const;
    let gainOff = 0;
    let gainOn = 0;
    let distOff = 0;
    let distOn = 0;
    for (const [A, B] of trips) {
      for (const r of planRoutes(A, B)) {
        gainOff += r.elevationGainMeters;
        distOff += r.distanceMeters;
      }
      for (const r of planRoutes(A, B, { avoidElevation: true })) {
        gainOn += r.elevationGainMeters;
        distOn += r.distanceMeters;
      }
    }
    expect(gainOn).toBeLessThan(gainOff);
    expect(distOn).toBeLessThan(distOff * 1.25);
  });

  it("reports the setting on every route it returns", () => {
    const rs = planRoutes({ lat: 37.7599, lng: -122.4148 }, { lat: 37.734, lng: -122.434 }, {
      avoidElevation: true,
    });
    for (const r of rs) expect(r.avoidedElevation).toBe(true);
  });

  it("is off by default and changes nothing then", () => {
    const rs = planRoutes({ lat: 37.7599, lng: -122.4148 }, { lat: 37.734, lng: -122.434 });
    for (const r of rs) expect(r.avoidedElevation).toBe(false);
  });
});
