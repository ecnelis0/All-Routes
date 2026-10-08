import { describe, expect, it } from "vitest";
import { buildElevationProfile, sampleElevation } from "./elevationProfile";
import { planRoutes } from "../routing/service";

// 300m due north: up 30m over the first 100m (30%), flat, then down 10m.
const M = 1 / 111_320;
const path = [0, 100, 200, 300].map((n) => ({ lat: 37.77 + n * M, lng: -122.42 }));
const elev = [10, 40, 40, 30];

describe("elevation profile", () => {
  const p = buildElevationProfile(path, elev)!;

  it("tracks climbed and dropped so far, including partway along a segment", () => {
    expect(sampleElevation(p, 0)).toMatchObject({ gained: 0, dropped: 0 });
    expect(sampleElevation(p, 50).gained).toBeCloseTo(15, 0); // half the first climb
    expect(sampleElevation(p, 150)).toMatchObject({ dropped: 0 });
    const end = sampleElevation(p, 300);
    expect(end.gained).toBeCloseTo(30, 5);
    expect(end.dropped).toBeCloseTo(10, 5);
  });

  it("reports the grade right here, with its direction", () => {
    expect(sampleElevation(p, 50).gradePercent).toBeCloseTo(30, 0);
    expect(sampleElevation(p, 150).gradePercent).toBeCloseTo(0, 5);
    expect(sampleElevation(p, 250).gradePercent).toBeCloseTo(-10, 0);
  });

  it("gives the slope as an angle too, and the change just ahead", () => {
    const here = sampleElevation(p, 50); // 30% up
    expect(here.gradeDegrees).toBeCloseTo(16.7, 1); // atan(0.30)
    // 50 m -> 210 m along: 25 m -> 39 m (10 m into the final 40 -> 30 m descent).
    expect(here.aheadChange).toBeCloseTo(14, 5);
    // Over the crest: 150 m -> 310 m (clamped to 300) is flat then down 10 m.
    const crest = sampleElevation(p, 150);
    expect(crest.aheadUp).toBeCloseTo(0, 5);
    expect(crest.aheadDown).toBeCloseTo(10, 5);
    // Up and over: 0 -> 160 m climbs 30 m (and drops none); net equals up here.
    expect(sampleElevation(p, 0).aheadUp).toBeCloseTo(30, 5);
    // Near the end, "ahead" is only what is left.
    const end = sampleElevation(p, 280);
    expect(end.aheadMeters).toBeCloseTo(20, 5);
    expect(end.aheadChange).toBeLessThan(0);
  });

  it("interpolates elevation between vertices", () => {
    expect(sampleElevation(p, 50).elevation).toBeCloseTo(25, 0);
    expect(p.minElev).toBe(10);
    expect(p.maxElev).toBe(40);
  });

  it("ends the tour on exactly the route's total gain and loss", () => {
    // The sidebar's numbers and the tour's must agree.
    const r = planRoutes({ lat: 37.79484, lng: -122.43103 }, { lat: 37.76308, lng: -122.42542 })[0];
    const prof = buildElevationProfile(r.path, r.pathElevations)!;
    const end = sampleElevation(prof, prof.totalMeters);
    expect(Math.abs(end.gained - r.elevationGainMeters)).toBeLessThanOrEqual(1);
    expect(Math.abs(end.dropped - r.elevationLossMeters)).toBeLessThanOrEqual(1);
  });

  it("refuses mismatched input rather than drawing a wrong profile", () => {
    expect(buildElevationProfile(path, [1, 2])).toBeNull();
  });
});
