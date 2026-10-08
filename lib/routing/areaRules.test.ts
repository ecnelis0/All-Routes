import { describe, expect, it } from "vitest";
import { AREA_DETOUR_LIMIT, planRoutes } from "./service";

/**
 * The owner's area rules: Severe areas are skipped whatever the detour;
 * High and Elevated areas are skipped unless staying out of all of them
 * makes the trip more than AREA_DETOUR_LIMIT longer than Fastest - then a
 * smaller detour through them wins.
 */
describe("area detour rules", () => {
  // Dogpatch -> West Portal: staying out of every area is ~68% longer than
  // the fastest route, far past the 40% limit.
  const A = { lat: 37.7683, lng: -122.3958 };
  const B = { lat: 37.7451, lng: -122.4957 };
  const by = Object.fromEntries(planRoutes(A, B).map((r) => [r.profile, r]));

  it("takes the smaller detour when staying out of every area is too long", () => {
    const s = by.balanced;
    // Either staying out is over the limit, or (null) no route stays out at all.
    expect(s.areaTradeoff).toBeTruthy();
    expect(s.areaTradeoff!.avoidAllExtraPercent ?? Infinity).toBeGreaterThan(AREA_DETOUR_LIMIT * 100);
    expect(s.distanceMeters).toBeLessThanOrEqual(by.fastest.distanceMeters * (1 + AREA_DETOUR_LIMIT));
    // ...going through a lower-tier area, never a Severe one.
    const entered = s.neighborhoodsEntered.filter((n) => !n.atEndpoint);
    expect(entered.length).toBeGreaterThan(0);
    for (const n of entered) expect(n.tier).not.toBe("Severe");
  });

  it("stays out of every area AND every crash hotspot when that is within the limit", () => {
    // The owner's screenshot: Marina -> Daly City on "Safest + bike lanes"
    // avoided all 17 flagged areas but crossed 9 crash-hotspot circles,
    // which the router did not treat as places to avoid. Staying out of
    // all of them costs +31% - inside the limit, so it must.
    const rs = planRoutes({ lat: 37.8029843, lng: -122.4374715 }, { lat: 37.7063084, lng: -122.4688905 }, {
      avoidElevation: true,
      fewerSignals: true,
    });
    for (const r of rs.filter((x) => x.profile !== "fastest")) {
      expect(r.areaTradeoff, r.label).toBeNull();
      expect(r.metersInFlaggedAreas, r.label).toBe(0);
      expect(r.crashHotspots.entered, r.label).toBe(0);
    }
  });
});

import { areaPolicy, areaTier, getRoutingEngine } from "./service";
import { SF_DANGEROUS_NEIGHBORHOODS } from "../data/sfDangerousNeighborhoods";

describe("area policy on every street block", () => {
  const eng = getRoutingEngine();
  const tierOfMask = (mask: number) => {
    const tiers = new Set<string>();
    SF_DANGEROUS_NEIGHBORHOODS.forEach((a, i) => {
      if (mask & (1 << i)) tiers.add(areaTier(a.risk));
    });
    return tiers;
  };

  it("budget mode blocks every Severe block and prices, not blocks, High/Elevated ones", () => {
    const budget = areaPolicy(eng, 0, "budget");
    let severe = 0;
    let lower = 0;
    for (let id = 0; id < eng.areaMask.length; id++) {
      const tiers = tierOfMask(eng.areaMask[id]);
      if (tiers.has("Severe")) {
        severe++;
        expect(budget.blocked(id)).toBe(true);
      } else if (tiers.size > 0) {
        lower++;
        expect(budget.blocked(id)).toBe(false);
        expect(budget.penalty(id)).toBeGreaterThan(0);
      }
    }
    expect(severe).toBeGreaterThan(1000);
    expect(lower).toBeGreaterThan(1000);
  });

  it("strict mode blocks every flagged block; exempt areas are priced instead", () => {
    const tenderloin = SF_DANGEROUS_NEIGHBORHOODS.findIndex((a) => a.id === "tenderloin");
    const strict = areaPolicy(eng, 1 << tenderloin, "strict");
    for (let id = 0; id < eng.areaMask.length; id++) {
      const m = eng.areaMask[id];
      if (m === 0) continue;
      if (m === 1 << tenderloin) {
        expect(strict.blocked(id)).toBe(false);
        expect(strict.penalty(id)).toBeGreaterThan(0); // leave it directly
      } else {
        expect(strict.blocked(id)).toBe(true);
      }
    }
  });
});
