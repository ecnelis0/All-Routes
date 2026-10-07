import { describe, expect, it } from "vitest";
import { planRoutes } from "./service";
import { buildAnnotations, activeAnnotation } from "../tour/annotations";
import { currentStreetAt } from "../tour/currentStreet";

/**
 * What the app is allowed to claim.
 *
 * Every case here is a false statement the app actually made to a user:
 * crossing flagged areas on a route labelled "Safest", taking credit for
 * avoiding a neighbourhood it was never going near, and captioning a
 * protected bike lane with the name of a street the rider had already
 * left. A wrong-but-plausible claim is worse than silence, because it is
 * the one number a rider might actually act on.
 */
const PTS: [string, { lat: number; lng: number }][] = [
  ["Ocean Beach", { lat: 37.7562, lng: -122.5102 }],
  ["Ferry Building", { lat: 37.7955, lng: -122.3937 }],
  ["Twin Peaks", { lat: 37.7544, lng: -122.4477 }],
  ["Bayview", { lat: 37.7299, lng: -122.3869 }],
  ["Union Square", { lat: 37.788, lng: -122.4075 }],
  ["Golden Gate Park", { lat: 37.7694, lng: -122.4822 }],
  ["17th & Mission", { lat: 37.76308, lng: -122.42542 }],
  ["Pacific Heights", { lat: 37.79484, lng: -122.43103 }],
];

function allRoutes() {
  const out = [];
  for (const [an, A] of PTS) {
    for (const [bn, B] of PTS) {
      if (an === bn) continue;
      try {
        out.push({ pair: `${an} -> ${bn}`, routes: planRoutes(A, B) });
      } catch {
        /* unreachable pairs are covered by snapping.test.ts */
      }
    }
  }
  return out;
}

const ALL = allRoutes();

describe("flagged-area avoidance is a promise, not a preference", () => {
  it("the safer profiles never enter a Severe area unless the trip starts or ends in it", () => {
    // The owner's rule: Severe areas are skipped whatever the detour.
    for (const { pair, routes } of ALL) {
      for (const r of routes) {
        if (r.profile === "fastest") continue;
        for (const n of r.neighborhoodsEntered) {
          if (n.tier === "Severe") expect(n.atEndpoint, `${pair} [${r.profile}] ${n.name}`).toBe(true);
        }
      }
    }
  });

  it("enters High/Elevated areas only when it says why", () => {
    // Either the trip starts/ends there, or staying out broke the detour
    // limit and the route carries the trade-off it made.
    for (const { pair, routes } of ALL) {
      for (const r of routes) {
        if (r.profile === "fastest") continue;
        for (const n of r.neighborhoodsEntered) {
          if (n.atEndpoint) continue;
          expect(r.areaTradeoff, `${pair} [${r.profile}] entered ${n.name} without a reason`).toBeTruthy();
        }
      }
    }
  });

  it("one unavoidable area no longer switches off avoidance of all the others", () => {
    // Richmond -> Potrero Hill ends inside Potrero Hill. The old fallback
    // then stopped avoiding EVERY area and rode through SoMa and Civic
    // Center (both Severe) on the way.
    const r = planRoutes({ lat: 37.78, lng: -122.47 }, { lat: 37.758, lng: -122.398 }).find(
      (x) => x.profile === "balanced"
    )!;
    expect(r.neighborhoodsEntered.map((n) => n.name)).toEqual(["Potrero Hill"]);
  });

  it("cuts flagged exposure far below the fastest route on average", () => {
    let fast = 0;
    let safe = 0;
    for (const { routes } of ALL) {
      const f = routes.find((r) => r.profile === "fastest")!;
      const s = routes.find((r) => r.profile === "balanced")!;
      fast += f.metersInFlaggedAreas / Math.max(1, f.distanceMeters);
      safe += s.metersInFlaggedAreas / Math.max(1, s.distanceMeters);
    }
    expect(safe / ALL.length).toBeLessThan((fast / ALL.length) * 0.75);
  });
});

describe("avoidance claims are counterfactual", () => {
  it("the fastest route never claims to have avoided anything", () => {
    // It is the baseline and makes no attempt to avoid anything, yet it
    // used to report dodging the Tenderloin on trips nowhere near it.
    for (const { pair, routes } of ALL) {
      const f = routes.find((r) => r.profile === "fastest")!;
      expect(f.avoidedNearby, pair).toHaveLength(0);
    }
  });

  it("only claims areas the fastest route actually entered", () => {
    for (const { pair, routes } of ALL) {
      const entered = new Set(
        routes.find((r) => r.profile === "fastest")!.neighborhoodsEntered.map((n) => n.name)
      );
      for (const r of routes) {
        for (const a of r.avoidedNearby) {
          expect(entered.has(a.name), `${pair} [${r.profile}] claimed ${a.name}`).toBe(true);
        }
      }
    }
  });

  it("never claims to avoid an area it is riding through", () => {
    for (const { pair, routes } of ALL) {
      for (const r of routes) {
        const inside = new Set(r.neighborhoodsEntered.map((n) => n.name));
        for (const a of r.avoidedNearby) {
          expect(inside.has(a.name), `${pair} [${r.profile}] ${a.name}`).toBe(false);
        }
      }
    }
  });
});

describe("protected-lane callouts name the street you are on", () => {
  it("effectively never names a different road", () => {
    // Measured at 9.9% before the fixes: the callout window outlived the
    // lane, spans merged across name changes, and - the big one - the
    // distance accumulator was incremented before protectedSpans were
    // built, offsetting every span by one edge.
    let total = 0;
    let wrong = 0;
    const examples: string[] = [];
    const norm = (x: string) =>
      x
        .toLowerCase()
        .replace(/\b(street|st|avenue|ave|boulevard|blvd|cyclepath|bikeway|path|drive|dr|way)\b/g, "")
        .replace(/[^a-z0-9]/g, "");

    for (const { pair, routes } of ALL) {
      for (const r of routes) {
        const anns = buildAnnotations(r.protectedSpans, r.avoidedNearby);
        for (let m = 0; m <= r.distanceMeters; m += 25) {
          const a = activeAnnotation(anns, m);
          if (!a || a.kind !== "protected" || a.detail === "Separated path") continue;
          const street = currentStreetAt(r.streetSpans, m);
          if (!street) continue;
          total++;
          if (street !== a.detail && norm(street) !== norm(a.detail)) {
            wrong++;
            if (examples.length < 5) examples.push(`${pair}: "${a.detail}" vs "${street}"`);
          }
        }
      }
    }
    expect(total).toBeGreaterThan(1000); // the sample is meaningful
    const rate = wrong / total;
    expect(rate, `${(100 * rate).toFixed(2)}% wrong\n${examples.join("\n")}`).toBeLessThan(0.01);
  });
});

describe("long detours are disclosed", () => {
  it("warns whenever a profile exceeds the fastest route by more than half", () => {
    for (const { pair, routes } of ALL) {
      const fast = routes.find((r) => r.profile === "fastest")!;
      for (const r of routes) {
        const over = r.distanceMeters > fast.distanceMeters * 1.5;
        if (over) {
          expect(r.detourWarning, `${pair} [${r.profile}] should warn`).not.toBeNull();
        } else {
          expect(r.detourWarning, `${pair} [${r.profile}] should not warn`).toBeNull();
        }
      }
    }
  });
});
