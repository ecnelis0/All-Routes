import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  buildCameraPath,
  lerpBearing,
  pathBounds,
  sampleCameraPath,
  segmentMeters,
  shortestTurn,
} from "./camera";
import type { LatLng } from "../types";

const SF: LatLng = { lat: 37.7749, lng: -122.4194 };

describe("bearingDegrees", () => {
  it("reads 0 for due north and 90 for due east", () => {
    expect(bearingDegrees(SF, { lat: SF.lat + 0.01, lng: SF.lng })).toBeCloseTo(0, 1);
    expect(bearingDegrees(SF, { lat: SF.lat, lng: SF.lng + 0.01 })).toBeCloseTo(90, 1);
    expect(bearingDegrees(SF, { lat: SF.lat - 0.01, lng: SF.lng })).toBeCloseTo(180, 1);
    expect(bearingDegrees(SF, { lat: SF.lat, lng: SF.lng - 0.01 })).toBeCloseTo(270, 1);
  });

  it("always returns 0-360, never negative", () => {
    for (const d of [
      { lat: -0.01, lng: -0.01 },
      { lat: 0.01, lng: -0.01 },
      { lat: -0.01, lng: 0.01 },
    ]) {
      const b = bearingDegrees(SF, { lat: SF.lat + d.lat, lng: SF.lng + d.lng });
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe("shortestTurn", () => {
  it("takes the short way around north", () => {
    // The classic compass bug: 350 -> 10 is a 20 degree right turn, not a
    // 340 degree left one. Getting this wrong spins the camera violently
    // at exactly the moment the rider turns gently through north.
    expect(shortestTurn(350, 10)).toBe(20);
    expect(shortestTurn(10, 350)).toBe(-20);
  });

  it("handles plain turns and the 180 edge", () => {
    expect(shortestTurn(0, 90)).toBe(90);
    expect(shortestTurn(90, 0)).toBe(-90);
    expect(Math.abs(shortestTurn(0, 180))).toBe(180);
  });
});

describe("lerpBearing", () => {
  it("interpolates across the 360/0 seam without spinning", () => {
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpBearing(350, 10, 0.25)).toBeCloseTo(355, 6);
  });

  it("stays within 0-360", () => {
    for (let t = 0; t <= 1; t += 0.1) {
      const b = lerpBearing(350, 10, t);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe("buildCameraPath", () => {
  // A dogleg: east, then north. Vertex spacing is deliberately uneven.
  const path: LatLng[] = [
    { lat: 37.77, lng: -122.42 },
    { lat: 37.77, lng: -122.4 }, // ~1760m east
    { lat: 37.78, lng: -122.4 }, // ~1113m north
  ];

  it("resamples to roughly even spacing regardless of vertex spacing", () => {
    // Route vertices come from the graph, so their spacing follows how OSM
    // split each street. Flying vertex to vertex would crawl at junctions
    // and lurch down straights.
    const frames = buildCameraPath(path, 100);
    const gaps: number[] = [];
    for (let i = 1; i < frames.length - 1; i++) {
      gaps.push(frames[i].distanceMeters - frames[i - 1].distanceMeters);
    }
    for (const g of gaps) expect(g).toBeCloseTo(100, 6);
  });

  it("starts at the origin and ends exactly at the destination", () => {
    const frames = buildCameraPath(path, 100);
    expect(frames[0].center.lat).toBeCloseTo(path[0].lat, 6);
    expect(frames[0].center.lng).toBeCloseTo(path[0].lng, 6);
    const last = frames[frames.length - 1];
    expect(last.center.lat).toBeCloseTo(path[2].lat, 6);
    expect(last.center.lng).toBeCloseTo(path[2].lng, 6);
    expect(last.t).toBe(1);
  });

  it("reports monotonically increasing distance and progress", () => {
    const frames = buildCameraPath(path, 75);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].distanceMeters).toBeGreaterThanOrEqual(frames[i - 1].distanceMeters);
      expect(frames[i].t).toBeGreaterThanOrEqual(frames[i - 1].t);
    }
    expect(frames[frames.length - 1].t).toBe(1);
  });

  it("turns the camera from east to north across the dogleg", () => {
    const frames = buildCameraPath(path, 100);
    expect(frames[0].bearing).toBeGreaterThan(60);
    expect(frames[0].bearing).toBeLessThan(120);
    // Smoothing pulls the exact endpoints, so check the trend rather than 0.
    const last = frames[frames.length - 1].bearing;
    expect(last < 45 || last > 315).toBe(true);
  });

  it("keeps every bearing in 0-360 after smoothing", () => {
    for (const f of buildCameraPath(path, 50)) {
      expect(f.bearing).toBeGreaterThanOrEqual(0);
      expect(f.bearing).toBeLessThan(360);
    }
  });

  it("survives degenerate inputs", () => {
    expect(buildCameraPath([], 50)).toEqual([]);
    expect(buildCameraPath([SF], 50)).toHaveLength(1);
    // Two identical points: zero length, must not divide by zero or hang.
    const same = buildCameraPath([SF, { ...SF }], 50);
    expect(same.length).toBeGreaterThan(0);
    for (const f of same) expect(Number.isFinite(f.bearing)).toBe(true);
  });
});

describe("sampleCameraPath", () => {
  const frames = buildCameraPath(
    [
      { lat: 37.77, lng: -122.42 },
      { lat: 37.77, lng: -122.4 },
    ],
    100
  );

  it("clamps out-of-range progress instead of extrapolating", () => {
    expect(sampleCameraPath(frames, -5)!.t).toBe(0);
    expect(sampleCameraPath(frames, 99)!.t).toBe(1);
  });

  it("returns null for an empty path", () => {
    expect(sampleCameraPath([], 0.5)).toBeNull();
  });

  it("interpolates between keyframes rather than stepping across them", () => {
    // Sampling finely must produce finely-spaced positions. If sampling
    // snapped to the nearest keyframe, most tiny steps would move 0m and
    // occasional ones would jump a whole 100m frame gap - which plays back
    // as a visible stutter. The earlier continuity test could not see this:
    // its 120m threshold is larger than the frame spacing it was meant to
    // police.
    const total = frames[frames.length - 1].distanceMeters;
    const dt = 0.005;
    const expectedStep = total * dt; // ~9m at 100m spacing over ~1760m
    let prev = sampleCameraPath(frames, 0)!;
    let maxStep = 0;
    for (let t = dt; t <= 1; t += dt) {
      const cur = sampleCameraPath(frames, t)!;
      maxStep = Math.max(maxStep, segmentMeters(prev.center, cur.center));
      prev = cur;
    }
    expect(maxStep).toBeLessThan(expectedStep * 3);
  });

  it("moves continuously, with no jumps between samples", () => {
    let prev = sampleCameraPath(frames, 0)!;
    for (let t = 0.02; t <= 1; t += 0.02) {
      const cur = sampleCameraPath(frames, t)!;
      expect(segmentMeters(prev.center, cur.center)).toBeLessThan(120);
      prev = cur;
    }
  });
});

describe("pathBounds", () => {
  it("covers every point", () => {
    const b = pathBounds([
      { lat: 37.75, lng: -122.45 },
      { lat: 37.8, lng: -122.39 },
      { lat: 37.77, lng: -122.5 },
    ])!;
    expect(b[0]).toEqual([-122.5, 37.75]);
    expect(b[1]).toEqual([-122.39, 37.8]);
  });

  it("returns null for an empty path", () => {
    expect(pathBounds([])).toBeNull();
  });
});
