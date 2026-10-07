import { describe, expect, it } from "vitest";
import { divergences, judge, suggestEdits, MAX_ADDED_MINUTES, MAX_SUGGESTIONS } from "./suggest";
import { getRoutingEngine, planCustomPath, areaTier } from "./service";
import { SF_DANGEROUS_NEIGHBORHOODS } from "../data/sfDangerousNeighborhoods";
import { distanceToPath } from "../ui/geometry";

describe("divergences", () => {
  it("finds where the alternative leaves and rejoins, in base and candidate indices", () => {
    //            0  1  2  3  4  5
    const base = [1, 2, 3, 4, 5, 6];
    const cand = [1, 2, 9, 8, 5, 6];
    expect(divergences(base, cand)).toEqual([{ bs: 1, be: 4, cs: 1, ce: 4 }]);
  });

  it("never rejoins BEHIND where it left - a splice must not send the rider backwards", () => {
    const base = [1, 2, 3, 4, 5];
    const cand = [1, 4, 9, 2, 3, 5]; // leaves at 4, touches 2 (behind) - must rejoin at 5
    const d = divergences(base, cand);
    for (const x of d) expect(x.be).toBeGreaterThan(x.bs);
  });

  it("finds nothing when the routes are the same", () => {
    expect(divergences([1, 2, 3], [1, 2, 3])).toEqual([]);
  });
});

const stats = (o: Partial<{ meters: number; climb: number; dangerMeters: number; lights: number }>) => ({
  meters: 1000,
  climb: 0,
  dangerMeters: 50_000,
  lights: 0,
  areas: new Map<number, number>(),
  ...o,
});

describe("judge", () => {
  it("states a time saving and its cost in climbing", () => {
    const v = judge(stats({ meters: 2000, dangerMeters: 50_000 }), stats({ meters: 1000, climb: 40, dangerMeters: 25_000 }), "via Noe Street")!;
    expect(v.kind).toBe("faster");
    expect(v.headline).toBe("Save 5 min via Noe Street - costs +131 ft climbing");
  });

  it("says 'no downside' when the stretch is simply better", () => {
    const v = judge(stats({ climb: 30 }), stats({ climb: 0 }), "via Fell Street")!;
    expect(v.headline).toBe("Skip 98 ft of climbing via Fell Street - no downside");
  });

  it("ignores trivial differences", () => {
    expect(judge(stats({}), stats({ meters: 1100, climb: 5 }), "x")).toBeNull();
  });

  it("refuses edits that add a lot of time for a small comfort gain", () => {
    const longer = (MAX_ADDED_MINUTES + 2) * 60 * 3.6 + 1000;
    expect(judge(stats({ climb: 60 }), stats({ meters: longer, climb: 0, dangerMeters: longer * 50 }), "x")).toBeNull();
  });
});

describe("suggestEdits on a real route", () => {
  // Noe Valley -> North Beach on Safest with "Avoid hills": the safe route
  // goes the long way round, so there is real time to be bought with hills.
  const A = { lat: 37.7516, lng: -122.4321 };
  const B = { lat: 37.8012, lng: -122.409 };
  const opts = { avoidElevation: true };
  const s = suggestEdits(A, B, [], "balanced", opts);
  const eng = getRoutingEngine();
  const base = planCustomPath(A, B, [], "balanced", opts);

  it("offers the owner's example: a faster way at the cost of a hill", () => {
    const fast = s.find((x) => x.kind === "faster");
    expect(fast).toBeDefined();
    expect(fast!.headline).toMatch(/^Save \d+ min via .+ - costs .*ft climbing/);
    expect(fast!.route.distanceMeters).toBeLessThan(base.path.distanceMeters);
  });

  it("never suggests a Severe area the trip does not start or end in", () => {
    for (const x of s) {
      for (const n of x.route.neighborhoodsEntered) {
        if (areaTier(SF_DANGEROUS_NEIGHBORHOODS.find((a) => a.name === n.name)!.risk) === "Severe") {
          expect(n.atEndpoint, `${x.headline} enters ${n.name}`).toBe(true);
        }
      }
    }
  });

  it("each edited route really is the old route with one stretch swapped", () => {
    for (const x of s) {
      const len = (p: { lat: number; lng: number }[]) => {
        let t = 0;
        for (let i = 1; i < p.length; i++) t += distanceToPath(p[i], [p[i - 1], p[i - 1]]);
        return t;
      };
      const expected = base.path.distanceMeters - len(x.replacedPath) + len(x.sectionPath);
      expect(Math.abs(x.route.distanceMeters - expected)).toBeLessThan(25);
      // ...and it passes the checkpoint shown on the map.
      expect(distanceToPath(x.checkpoint, x.route.path)).toBeLessThan(1);
      expect(x.route.acceptedSuggestions).toEqual([x.headline]);
    }
  });

  it("keeps the list short", () => {
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    expect(eng.graph.edges.length).toBeGreaterThan(0);
  });
});

import { planRoutes, planCustomRoute, routePathFromLatLngs } from "./service";

describe("suggestions are measured against the route on screen", () => {
  // Reproduced in the browser: S2 "Quieter streets via Grant Avenue - no
  // downside" rewrote the whole trip (+1.8 mi through the Mission) once
  // applied, because the server re-planned a different "base" route.
  const A = { lat: 37.7516, lng: -122.4321 };
  const B = { lat: 37.8012, lng: -122.409 };
  const opts = { avoidElevation: true };
  const shown = planRoutes(A, B, opts).find((r) => r.profile === "balanced")!;

  it("rebuilds the exact graph route behind a drawn path", () => {
    const rebuilt = routePathFromLatLngs(shown.path)!;
    expect(rebuilt).not.toBeNull();
    expect(Math.abs(rebuilt.distanceMeters - shown.distanceMeters)).toBeLessThan(2);
  });

  it("an edited route with no stops IS the Safest route it was based on", () => {
    // Both settings: with "Avoid hills" on, the hill costs happened to hide
    // the bug (both planners agreed); with it off, the old edit planner
    // gave 7.7 km through 1.2 km of flagged area vs Safest's 8.9 km and 0.
    for (const o of [opts, {}]) {
      const stock = planRoutes(A, B, o).find((r) => r.profile === "balanced")!;
      const mine = planCustomRoute(A, B, [], "balanced", o);
      expect(Math.abs(mine.distanceMeters - stock.distanceMeters)).toBeLessThan(2);
      expect(mine.metersInFlaggedAreas).toBe(stock.metersInFlaggedAreas);
    }
  });

  it("applying any suggestion changes only its own stretch", () => {
    const s = suggestEdits(A, B, [], "balanced", opts, [], shown.path);
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      const len = (p: { lat: number; lng: number }[]) => {
        let t = 0;
        for (let i = 1; i < p.length; i++) t += distanceToPath(p[i], [p[i - 1], p[i - 1]]);
        return t;
      };
      const expected = shown.distanceMeters - len(x.replacedPath) + len(x.sectionPath);
      expect(Math.abs(x.route.distanceMeters - expected), x.headline).toBeLessThan(25);
      // A "no downside" edit must not add flagged-area riding anywhere.
      if (x.costs.length === 0) {
        expect(x.route.metersInFlaggedAreas, x.headline).toBeLessThanOrEqual(shown.metersInFlaggedAreas);
      }
    }
  });
});
