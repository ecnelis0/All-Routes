import { describe, expect, it } from "vitest";
import { planRoutes } from "./service";

/**
 * "Safest + bike lanes" is Safest with an extra preference, so it must
 * never be the shorter of the two. Reported on Noe Valley -> North Beach
 * with "Avoid hills" on: Safest 6.06 mi, Safest + bike lanes 5.56 mi.
 */
const NOE_VALLEY = { lat: 37.7515906, lng: -122.4320814 };
const NORTH_BEACH = { lat: 37.8011749, lng: -122.4090021 };

const TRIPS: [string, { lat: number; lng: number }, { lat: number; lng: number }][] = [
  ["Noe Valley -> North Beach", NOE_VALLEY, NORTH_BEACH],
  ["Richmond -> Potrero", { lat: 37.78, lng: -122.47 }, { lat: 37.758, lng: -122.398 }],
  ["Pacific Heights -> Mission", { lat: 37.79484, lng: -122.43103 }, { lat: 37.76308, lng: -122.42542 }],
  ["Ocean Beach -> Ferry Building", { lat: 37.7596, lng: -122.5107 }, { lat: 37.7955, lng: -122.3937 }],
];
const OPTIONS = [
  {},
  { avoidElevation: true },
  { fewerSignals: true },
  { avoidElevation: true, fewerSignals: true },
];

describe("Safest + bike lanes is never shorter than Safest", () => {
  it("holds on the reported trip with Avoid hills on", () => {
    const by = Object.fromEntries(planRoutes(NOE_VALLEY, NORTH_BEACH, { avoidElevation: true }).map((r) => [r.profile, r]));
    expect(by.safest.distanceMeters).toBeGreaterThanOrEqual(by.balanced.distanceMeters);
  });

  for (const [name, a, b] of TRIPS) {
    for (const opts of OPTIONS) {
      it(`${name} ${JSON.stringify(opts)}`, () => {
        const by = Object.fromEntries(planRoutes(a, b, opts).map((r) => [r.profile, r]));
        expect(by.safest.distanceMeters).toBeGreaterThanOrEqual(by.balanced.distanceMeters);
        // And the fix must not undo area avoidance or the safety order.
        // (Skipped for best-effort pairs - e.g. a destination inside a
        // flagged area - where the tiers trade danger against flagged
        // metres differently; that is a separate, pre-existing question.)
        const bestEffort = [by.safest, by.balanced].some((r) => r.label.endsWith("best effort"));
        if (!bestEffort) {
          expect(by.safest.metersInFlaggedAreas).toBeLessThanOrEqual(by.balanced.metersInFlaggedAreas + 1);
        }
        expect(by.safest.meanDanger).toBeLessThanOrEqual(by.balanced.meanDanger + 1e-9);
      });
    }
  }
});
