import { describe, expect, it } from "vitest";
import { alongPath, insertWaypoint } from "./geometry";

// A straight 1km route due north.
const M = 1 / 111_320;
const at = (north: number, east = 0) => ({
  lat: 37.77 + north * M,
  lng: -122.42 + east / (111_320 * Math.cos((37.77 * Math.PI) / 180)),
});
const path = [at(0), at(500), at(1000)];

describe("alongPath", () => {
  it("projects a point beside the route onto the distance travelled", () => {
    expect(alongPath(at(300, 40), path)).toBeCloseTo(300, -1);
    expect(alongPath(at(800, -25), path)).toBeCloseTo(800, -1);
  });
});

describe("insertWaypoint", () => {
  it("puts a new stop between the stops either side of it, not at the end", () => {
    const stops = [at(200, 50), at(900, 50)];
    const next = insertWaypoint(stops, at(500, -60), path);
    expect(next).toEqual([stops[0], at(500, -60), stops[1]]);
  });

  it("puts a stop near the start first and one near the end last", () => {
    const stops = [at(500, 30)];
    expect(insertWaypoint(stops, at(100, 30), path)[0]).toEqual(at(100, 30));
    expect(insertWaypoint(stops, at(950, 30), path).at(-1)).toEqual(at(950, 30));
  });
});
