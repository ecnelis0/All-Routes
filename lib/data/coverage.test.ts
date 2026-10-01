import { describe, expect, it } from "vitest";
import { COVERAGE_BOUNDS, isWithinCoverage } from "./coverage";
import { SF_DANGEROUS_NEIGHBORHOODS } from "./sfDangerousNeighborhoods";
import rawGraph from "./sfBikeGraph.json";

describe("COVERAGE_BOUNDS", () => {
  it("matches the bounds the routing graph was actually built with", () => {
    // The failure this prevents: the geocoder restricting searches to a
    // different box than the router can serve. When these drifted, "Ocean
    // Beach" (-122.511, outside the old narrower box) resolved to an
    // unrelated company downtown - a confident, completely wrong answer
    // with nothing in the UI to indicate it.
    const graphBounds = (rawGraph as { bounds: Record<string, number> }).bounds;
    expect(COVERAGE_BOUNDS.north).toBeCloseTo(graphBounds.north, 6);
    expect(COVERAGE_BOUNDS.south).toBeCloseTo(graphBounds.south, 6);
    expect(COVERAGE_BOUNDS.east).toBeCloseTo(graphBounds.east, 6);
    expect(COVERAGE_BOUNDS.west).toBeCloseTo(graphBounds.west, 6);
  });

  it("includes the landmarks that exposed the bug", () => {
    // Ocean Beach and Golden Gate Park both sit west of the old display
    // bounds. Any future narrowing that drops them should fail here.
    expect(isWithinCoverage(37.7562, -122.5102)).toBe(true); // Ocean Beach
    expect(isWithinCoverage(37.7694, -122.4822)).toBe(true); // Golden Gate Park
    expect(isWithinCoverage(37.8024, -122.4058)).toBe(true); // Coit Tower
  });

  it("excludes places outside San Francisco", () => {
    expect(isWithinCoverage(37.8044, -122.2712)).toBe(false); // Oakland
    expect(isWithinCoverage(37.4419, -122.1430)).toBe(false); // Palo Alto
  });

  it("contains every flagged neighbourhood", () => {
    // A flagged area outside coverage can never be routed around, which
    // would make it decorative.
    for (const n of SF_DANGEROUS_NEIGHBORHOODS) {
      expect(isWithinCoverage(n.center.lat, n.center.lng), n.name).toBe(true);
    }
  });
});
