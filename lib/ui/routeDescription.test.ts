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
  elevationLossMeters: 12,
  neighborhoodsEntered: [],
  areaTradeoff: null,
};

const texts = (r: DescribableRoute) => describeRoute(r, "18").choices.map((c) => c.text);

describe("describeRoute", () => {
  it("names the option and every choice it did or did not honour", () => {
    const d = describeRoute(base, "18");
    expect(d.title).toBe("Safest + bike lanes");
    expect(texts(base)).toEqual([
      "Avoided every Severe area",
      "Avoided every High and Elevated area",
      "Kept to protected bike lanes where possible",
      "Avoided hills",
      "Did not avoid traffic lights",
    ]);
    expect(d.stats).toEqual(["2.5 mi · ~18 min", "42% on protected lanes", "12 traffic lights", "▲ 98 ft / ▼ 39 ft"]);
  });

  it("explains a trip that starts or ends inside an area", () => {
    const r = {
      ...base,
      profile: "balanced" as const,
      label: "Safest · best effort",
      neighborhoodsEntered: [{ name: "Potrero Hill", meters: 1461, tier: "Elevated" as const, atEndpoint: true }],
    };
    expect(texts(r).slice(0, 2)).toEqual([
      "Avoided every Severe area",
      "Avoided every High and Elevated area, except Potrero Hill where the trip starts or ends",
    ]);
    expect(texts(r)).not.toContain("Kept to protected bike lanes where possible");
  });

  it("says why it went through a lower-tier area: the detour limit", () => {
    const r = {
      ...base,
      profile: "balanced" as const,
      label: "Safest",
      neighborhoodsEntered: [{ name: "Fillmore", meters: 483, tier: "High" as const, atEndpoint: false }],
      areaTradeoff: { avoidAllExtraPercent: 68, limitPercent: 40 },
    };
    expect(texts(r)[1]).toBe(
      "Went through Fillmore (High, 0.3 mi) - staying out of all of them would make the trip 68% longer than Fastest (limit 40%)"
    );
    expect(describeRoute(r, "18").choices[1].honoured).toBe(false);
  });

  it("never hides a Severe area it went through", () => {
    const r = {
      ...base,
      label: "Safest + bike lanes · best effort",
      neighborhoodsEntered: [{ name: "Tenderloin", meters: 400, tier: "Severe" as const, atEndpoint: false }],
    };
    expect(texts(r)[0]).toBe("Went through Severe areas: Tenderloin (Severe, 0.2 mi) - there was no other way");
  });

  it("never claims the fastest route avoided areas", () => {
    const r = { ...base, profile: "fastest" as const, label: "Fastest", avoidedElevation: false, preferredFewerSignals: true };
    expect(texts(r)).toEqual(["Did not avoid dangerous areas", "Did not avoid hills", "Avoided traffic lights"]);
  });
});

describe("describeRoute on an edited route", () => {
  it("says it is the rider's own route and how many stops it passes", () => {
    const r = { ...base, label: "My route (Safest + bike lanes)", customWaypoints: [{}, {}] };
    expect(texts(r)[0]).toBe("Your edited route · passes 2 stops you chose");
  });
});

describe("crash hotspots", () => {
  it("says whether the safer route kept out of crash hotspots, and why not", () => {
    const clear = { ...base, crashHotspots: { entered: 0, meters: 0 } };
    expect(texts(clear)).toContain("Avoided every crash hotspot");
    const through = {
      ...base,
      crashHotspots: { entered: 2, meters: 640 },
      areaTradeoff: { avoidAllExtraPercent: 55, limitPercent: 40 },
    };
    expect(texts(through)).toContain(
      "Went through 2 crash hotspots (0.4 mi) - staying out would make the trip 55% longer than Fastest (limit 40%)"
    );
  });
});

describe("describeRoute with accepted suggestions", () => {
  it("names each trade-off the rider chose, right after the edited-route line", () => {
    const r = {
      ...base,
      customWaypoints: [{}],
      acceptedSuggestions: ["Save 13 min via Noe Street - costs +598 ft climbing"],
    };
    expect(texts(r).slice(0, 2)).toEqual([
      "Your edited route · passes 1 stop you chose",
      "You chose: Save 13 min via Noe Street - costs +598 ft climbing",
    ]);
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
