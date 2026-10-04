import { describe, expect, it } from "vitest";
import {
  buildManeuvers,
  classifyTurn,
  cumulative,
  formatDistance,
} from "./instructions";
import { initialState, matchFix, type GpsFix } from "./tracker";
import { formatEta, simulatedFix } from "./simulate";
import { planRoutes } from "../routing/service";
import type { LatLng } from "../types";

// An L-shaped route: 400m north, then 400m east. North = +lat, east = +lng.
const M_LAT = 1 / 111_320;
const M_LNG = 1 / (111_320 * Math.cos((37.77 * Math.PI) / 180));
const O = { lat: 37.77, lng: -122.42 };
const at = (north: number, east: number): LatLng => ({
  lat: O.lat + north * M_LAT,
  lng: O.lng + east * M_LNG,
});
const L_PATH: LatLng[] = [];
for (let n = 0; n <= 400; n += 20) L_PATH.push(at(n, 0));
for (let e = 20; e <= 400; e += 20) L_PATH.push(at(400, e));
const L_SPANS = [
  { name: "Valencia Street", startMeters: 0, endMeters: 400 },
  { name: "16th Street", startMeters: 400, endMeters: 800 },
];

describe("classifyTurn", () => {
  it("maps heading change to the maneuver a rider would describe", () => {
    expect(classifyTurn(0)).toBe("straight");
    expect(classifyTurn(90)).toBe("right");
    expect(classifyTurn(-90)).toBe("left");
    expect(classifyTurn(30)).toBe("slight-right");
    expect(classifyTurn(-150)).toBe("sharp-left");
    expect(classifyTurn(178)).toBe("u-turn");
  });
});

describe("buildManeuvers", () => {
  const m = buildManeuvers(L_PATH, L_SPANS);

  it("starts with a depart, ends with an arrive", () => {
    expect(m[0].type).toBe("depart");
    expect(m[0].text).toMatch(/Head north on Valencia Street/);
    expect(m[m.length - 1].type).toBe("arrive");
  });

  it("calls a north-to-east corner a right turn at the right place", () => {
    const turn = m.find((x) => x.street === "16th Street")!;
    expect(turn.type).toBe("right");
    expect(turn.text).toBe("Turn right onto 16th Street");
    expect(turn.atMeters).toBeCloseTo(400, -1);
  });

  it("is not fooled by geometry wiggle at a junction", () => {
    // A 4m jog right at the corner swings a vertex-to-vertex bearing wildly;
    // measured over 30m windows the turn is still a clean right.
    const wiggly = L_PATH.slice();
    wiggly.splice(20, 0, at(399, 3), at(401, -2));
    const turn = buildManeuvers(wiggly, L_SPANS).find(
      (x) => x.street === "16th Street",
    )!;
    expect(turn.type).toBe("right");
  });

  it("absorbs a junction sliver of a cross street", () => {
    const sliver = [
      { name: "Valencia Street", startMeters: 0, endMeters: 196 },
      { name: "Duboce Avenue", startMeters: 196, endMeters: 203 },
      { name: "Valencia Street", startMeters: 203, endMeters: 400 },
      { name: "16th Street", startMeters: 400, endMeters: 800 },
    ];
    const streets = buildManeuvers(L_PATH, sliver).map((x) => x.street);
    expect(streets).toEqual(["Valencia Street", "16th Street", null]);
  });

  it("does not announce a street change when the name is unchanged", () => {
    const split = [
      { name: "Valencia Street", startMeters: 0, endMeters: 200 },
      { name: "Valencia Street", startMeters: 200, endMeters: 400 },
      { name: "16th Street", startMeters: 400, endMeters: 800 },
    ];
    const turns = buildManeuvers(L_PATH, split).filter(
      (x) => x.type !== "depart" && x.type !== "arrive",
    );
    expect(turns).toHaveLength(1);
  });
});

describe("formatDistance", () => {
  it("speaks feet up close and miles further out", () => {
    expect(formatDistance(20)).toBe("now");
    expect(formatDistance(100)).toBe("350 ft");
    expect(formatDistance(1609.34 * 1.24)).toBe("1.2 mi");
  });
});

const fix = (p: LatLng, extra: Partial<GpsFix> = {}): GpsFix => ({
  lat: p.lat,
  lng: p.lng,
  accuracy: 8,
  heading: null,
  speed: null,
  timestamp: 0,
  ...extra,
});

describe("matchFix", () => {
  const cum = cumulative(L_PATH);
  const man = buildManeuvers(L_PATH, L_SPANS);

  it("tracks progress and the distance to the next turn", () => {
    const r = matchFix(fix(at(300, 0)), L_PATH, cum, man, initialState());
    expect(r.state.alongMeters).toBeCloseTo(300, -1);
    expect(r.next?.street).toBe("16th Street");
    expect(r.metersToNext).toBeCloseTo(100, -1);
    expect(r.state.offRoute).toBe(false);
  });

  it("snaps a noisy fix onto the route", () => {
    // 15m east of the road - normal phone GPS error downtown.
    const r = matchFix(fix(at(200, 15)), L_PATH, cum, man, initialState());
    expect(r.distanceFromRoute).toBeCloseTo(15, 0);
    expect(r.state.alongMeters).toBeCloseTo(200, -1);
  });

  it("does not jump to a later part of the route that passes nearby", () => {
    // Out along one street and back along a parallel one 35m away. GPS
    // error pulls the fix to 5m from the return leg - nearer it than the
    // leg the rider is really on (30m). Nearest-point matching jumps ~650m
    // ahead; history must keep the rider on the outbound leg.
    const out: LatLng[] = [];
    for (let n = 0; n <= 400; n += 20) out.push(at(n, 0));
    for (let n = 400; n >= 0; n -= 20) out.push(at(n, 35));
    const c = cumulative(out);
    const r = matchFix(fix(at(100, 30)), out, c, [], {
      ...initialState(),
      alongMeters: 90,
      furthestMeters: 90,
    });
    expect(r.state.alongMeters).toBeLessThan(200); // still on the outbound leg (~100m)
  });

  it("does not flip back to the previous turn when a corner fix jitters", () => {
    // One fix just past the corner, then a noisy one projecting 15m back
    // up Valencia: the banner must stay on the next instruction.
    let s = initialState();
    s = matchFix(fix(at(380, 0)), L_PATH, cum, man, s).state;
    s = matchFix(fix(at(400, 12)), L_PATH, cum, man, s).state;
    const r = matchFix(fix(at(388, 6)), L_PATH, cum, man, s);
    expect(r.state.alongMeters).toBeLessThan(400); // raw match did go back...
    expect(r.next?.type).toBe("arrive"); // ...the instruction did not
  });

  it("reroutes only after several consecutive bad fixes", () => {
    let s = initialState();
    const far = fix(at(200, 150));
    s = matchFix(far, L_PATH, cum, man, s).state;
    expect(s.offRoute).toBe(false); // one wild fix is not a reroute
    s = matchFix(far, L_PATH, cum, man, s).state;
    s = matchFix(far, L_PATH, cum, man, s).state;
    expect(s.offRoute).toBe(true);
  });

  it("does not drag progress forward on a wild fix", () => {
    const s = { ...initialState(), alongMeters: 200, furthestMeters: 200 };
    const r = matchFix(fix(at(200, 200)), L_PATH, cum, man, s); // 200m from both legs
    expect(r.state.alongMeters).toBe(200);
  });

  it("recovers after a long GPS gap without recursing forever", () => {
    // A fix far beyond the forward window from a stale position.
    const r = matchFix(fix(at(400, 380)), L_PATH, cum, man, initialState());
    expect(r.state.alongMeters).toBeGreaterThan(700);
  });

  it("declares arrival near the destination", () => {
    const r = matchFix(fix(at(400, 395)), L_PATH, cum, man, {
      ...initialState(),
      alongMeters: 760,
      furthestMeters: 760,
    });
    expect(r.state.arrived).toBe(true);
  });
});

describe("instructions on a real route", () => {
  it("produces a sensible, ordered set of maneuvers", () => {
    const r = planRoutes(
      { lat: 37.79484, lng: -122.43103 },
      { lat: 37.76308, lng: -122.42542 },
    )[0];
    const m = buildManeuvers(r.path, r.streetSpans);
    expect(m[0].type).toBe("depart");
    expect(m[m.length - 1].type).toBe("arrive");
    for (let i = 1; i < m.length; i++)
      expect(m[i].atMeters).toBeGreaterThanOrEqual(m[i - 1].atMeters);
    // Every turn names a real street on the route.
    const streets = new Set(r.streets);
    for (const x of m) if (x.street) expect(streets.has(x.street)).toBe(true);
  });
});

describe("simulator", () => {
  const cum = cumulative(L_PATH);

  it("pushes a lateral offset to the rider's right", () => {
    // Heading north, right is east.
    const f = simulatedFix(L_PATH, cum, 200, { lateralMeters: 50 });
    expect(f.lng).toBeGreaterThan(O.lng);
    expect(f.heading).toBeCloseTo(0, 0);
    const r = matchFix(f, L_PATH, cum, [], initialState());
    expect(r.distanceFromRoute).toBeCloseTo(50, 0);
  });

  it("formats ETAs", () => {
    expect(formatEta(2700)).toBe("10 min");
    expect(formatEta(4.5 * 60 * 65)).toBe("1 h 5 min");
  });

  it("riding a real route end to end announces every turn in order and arrives", () => {
    const r = planRoutes(
      { lat: 37.79484, lng: -122.43103 },
      { lat: 37.76308, lng: -122.42542 },
    )[1];
    const c = cumulative(r.path);
    const man = buildManeuvers(r.path, r.streetSpans);
    const total = c[c.length - 1];
    let s = initialState();
    const announced: string[] = [];
    for (let d = 0; d <= total + 5; d += 4.5) {
      // Realistic phone noise: alternate 8m either side of the line.
      const res = matchFix(
        simulatedFix(r.path, c, d, { lateralMeters: d % 9 < 4.5 ? 8 : -8 }),
        r.path,
        c,
        man,
        s,
      );
      s = res.state;
      expect(s.offRoute).toBe(false);
      if (res.next && announced[announced.length - 1] !== res.next.text)
        announced.push(res.next.text);
    }
    expect(s.arrived).toBe(true);
    expect(announced).toEqual(man.slice(1).map((m) => m.text));
  });
});
