import { describe, expect, it } from "vitest";
import { planRoutes } from "./service";
import { SF_DANGEROUS_NEIGHBORHOODS } from "../data/sfDangerousNeighborhoods";

/**
 * End-to-end behavioural tests against the real SF graph and the real
 * model artifact. These are the tests that would actually notice the
 * product being broken - the unit tests around them check that each piece
 * behaves, this checks that the pieces together do the thing the app
 * exists to do.
 *
 * Deliberately asserts on *direction and magnitude* rather than exact
 * numbers: retraining the model should not break these, but a model or
 * router change that stops avoiding danger must.
 */

// Crosses the Tenderloin / SoMa / Civic Center cluster head-on.
const RICHMOND = { lat: 37.78, lng: -122.47 };
const POTRERO = { lat: 37.758, lng: -122.398 };

describe("route safety behaviour on the real network", () => {
  const routes = planRoutes(RICHMOND, POTRERO);
  const byProfile = Object.fromEntries(routes.map((r) => [r.profile, r]));

  it("returns all three profiles", () => {
    expect(Object.keys(byProfile).sort()).toEqual(["balanced", "fastest", "safest"]);
  });

  it("makes safer profiles genuinely less dangerous, never more", () => {
    // The promise a rider relies on. A stricter hard-avoid ceiling shrinks
    // the feasible set, so without explicit ordering the "safest" tier can
    // legitimately come back worse than "safer" - see enforceSafetyOrdering.
    expect(byProfile.balanced.meanDanger).toBeLessThanOrEqual(byProfile.fastest.meanDanger);
    expect(byProfile.safest.meanDanger).toBeLessThanOrEqual(byProfile.balanced.meanDanger);
  });

  it("substantially cuts distance ridden inside flagged neighbourhoods", () => {
    const fastShare = byProfile.fastest.metersInFlaggedAreas / byProfile.fastest.distanceMeters;
    const safeShare = byProfile.safest.metersInFlaggedAreas / byProfile.safest.distanceMeters;
    expect(fastShare).toBeGreaterThan(0.3); // this pair deliberately runs through them
    expect(safeShare).toBeLessThan(fastShare * 0.75);
  });

  it("buys safety with a tolerable amount of extra distance", () => {
    // A router that will ride forever to shave a danger point is useless.
    expect(byProfile.safest.distanceMeters).toBeLessThan(
      byProfile.fastest.distanceMeters * 2.5
    );
  });

  it("puts more of the safer route on protected infrastructure", () => {
    expect(byProfile.balanced.protectedLaneFraction).toBeGreaterThan(
      byProfile.fastest.protectedLaneFraction
    );
  });

  it("never routes onto a street above the profile's hard-avoid ceiling", () => {
    // The one hard guarantee. A soft weight alone can always be outvoted by
    // a long enough detour; this is what makes "never" mean never.
    expect(byProfile.safest.maxDanger).toBeLessThan(92);
  });

  it("reports which flagged neighbourhoods it entered, with distances", () => {
    const entered = byProfile.fastest.neighborhoodsEntered;
    expect(entered.length).toBeGreaterThan(0);
    const known = new Set(SF_DANGEROUS_NEIGHBORHOODS.map((n) => n.name));
    for (const e of entered) {
      expect(known.has(e.name)).toBe(true);
      expect(e.meters).toBeGreaterThan(0);
    }
    // Sorted worst-first so the UI can show the headline offender.
    const meters = entered.map((e) => e.meters);
    expect([...meters].sort((a, b) => b - a)).toEqual(meters);
  });

  it("agrees between per-area distances and the flagged total", () => {
    // Areas overlap (SoMa and Downtown share blocks), so the per-area sum
    // should be >= the total, never less - a smaller sum would mean the
    // total is counting distance no named area claims.
    for (const r of routes) {
      const sum = r.neighborhoodsEntered.reduce((a, e) => a + e.meters, 0);
      expect(sum).toBeGreaterThanOrEqual(r.metersInFlaggedAreas - 1);
    }
  });

  it("produces continuous geometry with no teleports", () => {
    // A path that jumps is the signature of a broken reconstruction; it
    // renders as a straight line across the city and looks almost
    // plausible at low zoom.
    for (const r of routes) {
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i];
        const b = r.path[i + 1];
        const dLat = (a.lat - b.lat) * 111_320;
        const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
        expect(Math.sqrt(dLat * dLat + dLng * dLng)).toBeLessThan(600);
      }
    }
  });
});
