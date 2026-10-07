import { describe, expect, it } from "vitest";
import { ALONG_METERS, choosePlaces, planInterestRoutes, STYLE, type Poi } from "./planner";
import { distanceToPath } from "../ui/geometry";
import { areaTier } from "../routing/service";
import { SF_DANGEROUS_NEIGHBORHOODS } from "../data/sfDangerousNeighborhoods";

// A straight 5 km test line due north through the west side of SF.
const M = 1 / 111_320;
const LNG = -122.47;
const mPerLng = 111_320 * Math.cos((37.76 * Math.PI) / 180);
const at = (north: number, east = 0) => ({ lat: 37.74 + north * M, lng: LNG + east / mPerLng });
const line = [at(0), at(2500), at(5000)];
const poi = (id: string, category: Poi["category"], north: number, east: number): Poi => ({
  id,
  category,
  name: id,
  ...at(north, east),
});

describe("choosePlaces", () => {
  const pois = [
    poi("beach-near", "beach", 2000, 100),
    poi("boba-too-close-to-beach", "boba", 2100, 40), // closer to the line, but 100 m from the beach
    poi("boba-later", "boba", 3500, 80),
    poi("boba-far-off", "boba", 1500, 2000), // outside any corridor
    poi("boba-at-start", "boba", 100, 10), // where the rider already is
    poi("park-1", "park", 1200, 150),
    poi("park-2", "park", 4200, 200),
  ];

  it("Quick: at most 2 stops, one per interest, spaced out, closest to the line", () => {
    const picked = choosePlaces(pois, ["beach", "boba"], line, 5000, "quick").map((p) => p.id);
    expect(picked).toEqual(["beach-near", "boba-later"]);
  });

  it("keeps stops in riding order and inside the detour budget", () => {
    const picked = choosePlaces(pois, ["beach", "boba", "park"], line, 5000, "relaxed");
    const alongs = picked.map((p) => p.lat);
    expect(alongs).toEqual([...alongs].sort((a, b) => a - b));
    const detour = picked.reduce((t, p) => t + 2 * distanceToPath(p, line), 0);
    expect(detour).toBeLessThanOrEqual(STYLE.relaxed.budget * 5000);
    expect(picked.length).toBeLessThanOrEqual(STYLE.relaxed.maxStops);
  });

  it("never picks a place far off the route or at the very start", () => {
    const picked = choosePlaces(pois, ["boba"], line, 5000, "relaxed").map((p) => p.id);
    expect(picked).not.toContain("boba-far-off");
    expect(picked).not.toContain("boba-at-start");
  });

  it("never picks a place inside a Severe area", () => {
    const tl = SF_DANGEROUS_NEIGHBORHOODS.find((a) => a.id === "tenderloin")!;
    const path = [
      { lat: tl.center.lat - 0.02, lng: tl.center.lng },
      { lat: tl.center.lat + 0.02, lng: tl.center.lng },
    ];
    const inside: Poi = { id: "tl-boba", category: "boba", name: "x", ...tl.center };
    expect(choosePlaces([inside], ["boba"], path, 4400, "relaxed")).toEqual([]);
  });
});

describe("planInterestRoutes on the real network", () => {
  // Marina Green -> Inner Sunset, past the Presidio and Golden Gate Park.
  const A = { lat: 37.806, lng: -122.441 };
  const B = { lat: 37.764, lng: -122.466 };
  const rides = planInterestRoutes(A, B, ["park", "viewpoint"]);

  it("offers a choice, and Relaxed goes further for the rider's interests than Quick", () => {
    expect(rides.length).toBeGreaterThanOrEqual(1);
    if (rides.length === 2) {
      expect(rides[1].extraPercent).toBeGreaterThanOrEqual(rides[0].extraPercent);
      expect(rides[1].stops.length).toBeGreaterThanOrEqual(rides[0].stops.length);
    }
  });

  it("actually visits every stop, and labels only places truly on the way", () => {
    for (const r of rides) {
      for (const s of r.stops) expect(distanceToPath(s, r.route.path), s.name).toBeLessThan(150);
      for (const p of r.along) expect(distanceToPath(p, r.route.path)).toBeLessThanOrEqual(ALONG_METERS);
      expect(r.route.customWaypoints).toHaveLength(r.stops.length); // navigation reroutes keep them
    }
  });

  it("keeps the safety rules: no Severe area unless the trip starts or ends there", () => {
    for (const r of rides) {
      for (const n of r.route.neighborhoodsEntered) {
        const tier = areaTier(SF_DANGEROUS_NEIGHBORHOODS.find((a) => a.name === n.name)!.risk);
        if (tier === "Severe") expect(n.atEndpoint).toBe(true);
      }
    }
  });

  it("bike paths mean the protected-lane rules", () => {
    const [plain] = planInterestRoutes(A, B, ["park"]);
    const [paths] = planInterestRoutes(A, B, ["park", "bikepaths"]);
    expect(paths.route.protectedLaneFraction).toBeGreaterThanOrEqual(plain.route.protectedLaneFraction);
  });
});

describe("second pass on a reshaped, longer ride", () => {
  it("still finds stops in the last part of a ride longer than the plain line", () => {
    // The ride (5 km) is longer than the plain trip it was planned from
    // (3 km). A boba shop 4 km along is late in the ride but not at its end.
    const late = poi("boba-late", "boba", 4000, 50);
    const picked = choosePlaces([late], ["boba"], line, 3000, "relaxed");
    expect(picked.map((p) => p.id)).toEqual(["boba-late"]);
  });
});
