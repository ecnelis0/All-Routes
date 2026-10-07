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
    // Each stop is a street corner, so the route passes right by it.
    expect(distanceToPath(STOP_A, r.path)).toBeLessThan(40);
    expect(distanceToPath(STOP_B, r.path)).toBeLessThan(40);
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
