import { describe, expect, it } from "vitest";
import { describeRoute, type DescribableRoute } from "./routeDescription";
import { distanceToPath } from "./geometry";

const base: DescribableRoute = {
  profile: "safest",
  label: "Safest + bike lanes",
  distanceMeters: 1609.34 * 2.5,
  metersInFlaggedAreas: 0,
  protectedLaneFraction: 0.42,
  avoidedElevation: true,
  preferredFewerSignals: false,
  trafficSignals: 12,
  elevationGainMeters: 30,
};

const texts = (r: DescribableRoute) => describeRoute(r, "18").choices.map((c) => c.text);

describe("describeRoute", () => {
  it("names the option and every choice it did or did not honour", () => {
    const d = describeRoute(base, "18");
    expect(d.title).toBe("Safest + bike lanes");
    expect(texts(base)).toEqual([
      "Avoided all flagged dangerous areas",
      "Kept to protected bike lanes where possible",
      "Avoided hills",
      "Did not avoid traffic lights",
    ]);
    expect(d.stats).toEqual(["2.5 mi · ~18 min", "42% on protected lanes", "12 traffic lights", "98 ft of climbing"]);
  });

  it("is honest when a safe option could not avoid every area", () => {
    const r = { ...base, profile: "balanced" as const, label: "Safest · best effort", metersInFlaggedAreas: 805 };
    expect(texts(r)[0]).toBe("Could not fully avoid dangerous areas (0.5 mi inside)");
    expect(texts(r)).not.toContain("Kept to protected bike lanes where possible");
  });

  it("never claims the fastest route avoided areas", () => {
    const r = { ...base, profile: "fastest" as const, label: "Fastest", avoidedElevation: false, preferredFewerSignals: true };
    expect(texts(r)).toEqual(["Did not avoid dangerous areas", "Did not avoid hills", "Avoided traffic lights"]);
  });
});

describe("distanceToPath", () => {
  it("measures metres to the nearest segment, not the nearest vertex", () => {
    const path = [
      { lat: 37.77, lng: -122.42 },
      { lat: 37.78, lng: -122.42 }, // ~1.1 km north
    ];
    // Midway along, 10 m east: far from both vertices, 10 m from the line.
    const p = { lat: 37.775, lng: -122.42 + 10 / (111_320 * Math.cos((37.775 * Math.PI) / 180)) };
    expect(distanceToPath(p, path)).toBeCloseTo(10, 0);
  });
});
