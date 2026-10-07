import { describe, expect, it } from "vitest";
import { CLIMB_FLAT_EQUIVALENT_M, CRUISE_MPS, estimateSeconds, planRoutes, SIGNAL_WAIT_SECONDS } from "./service";

/**
 * "Fastest" means fastest by the time the rider is shown - and no safer
 * option may ever show a quicker time. Reported on North Beach -> Lakeshore
 * Plaza with "Avoid hills": Fastest 15,004 m vs Safest 14,673 m.
 */
const NORTH_BEACH = { lat: 37.8011749, lng: -122.4090021 };
const LAKESHORE_PLAZA = { lat: 37.7330235, lng: -122.490253 };
const TRIPS = [
  [NORTH_BEACH, LAKESHORE_PLAZA],
  [{ lat: 37.7516, lng: -122.4321 }, { lat: 37.8012, lng: -122.409 }], // Noe Valley -> North Beach
  [{ lat: 37.78, lng: -122.47 }, { lat: 37.758, lng: -122.398 }], // Richmond -> Potrero
  [{ lat: 37.7596, lng: -122.5107 }, { lat: 37.7955, lng: -122.3937 }], // Ocean Beach -> Ferry Building
] as const;
const OPTIONS = [{}, { avoidElevation: true }, { fewerSignals: true }, { avoidElevation: true, fewerSignals: true }];

describe("ride time", () => {
  it("counts distance, climbing and traffic-light waits", () => {
    expect(estimateSeconds(3600, 0, 0)).toBeCloseTo(3600 / CRUISE_MPS);
    expect(estimateSeconds(0, 10, 0)).toBeCloseTo((10 * CLIMB_FLAT_EQUIVALENT_M) / CRUISE_MPS);
    expect(estimateSeconds(0, 0, 5)).toBe(5 * SIGNAL_WAIT_SECONDS);
  });

  for (const [A, B] of TRIPS) {
    for (const o of OPTIONS) {
      it(`Fastest <= Safest <= Safest + bike lanes in time: ${A.lat},${A.lng} ${JSON.stringify(o)}`, () => {
        const by = Object.fromEntries(planRoutes(A, B, o).map((r) => [r.profile, r]));
        expect(by.fastest.estimatedSeconds).toBeLessThanOrEqual(by.balanced.estimatedSeconds);
        expect(by.fastest.estimatedSeconds).toBeLessThanOrEqual(by.safest.estimatedSeconds);
        expect(by.balanced.estimatedSeconds).toBeLessThanOrEqual(by.safest.estimatedSeconds);
        // The time shown is the route's own numbers, not a separate guess.
        for (const r of Object.values(by)) {
          expect(r.estimatedSeconds).toBeCloseTo(estimateSeconds(r.distanceMeters, r.elevationGainMeters, r.trafficSignals), -1);
        }
      });
    }
  }
});

import { FALLBACK_MPS, rideMinutes } from "../ui/rideTime";

describe("time shown in the app", () => {
  it("uses the router's estimate, falling back to distance only for old saved routes", () => {
    expect(FALLBACK_MPS).toBe(CRUISE_MPS);
    expect(rideMinutes({ distanceMeters: 3600, estimatedSeconds: 1500 })).toBe(25);
    expect(rideMinutes({ distanceMeters: 3600 })).toBe(17);
  });
});
