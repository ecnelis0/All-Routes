import { describe, expect, it } from "vitest";
import { edgeEntersSignal, getRoutingEngine, planRoutes } from "./service";
import signals from "../data/sfTrafficSignals.json";

const eng = getRoutingEngine();

describe("traffic signal data", () => {
  it("keeps only signals that actually stop a cyclist", () => {
    // The SFMTA inventory also lists pedestrian flashing beacons, radar
    // speed signs, message signs and pending/future signals. Counting those
    // would penalise routes for things that never stop anyone.
    const types = new Set(signals.signals.map((s) => s.type));
    for (const t of types) {
      expect(t, `unexpected type ${t}`).toMatch(/^(SIGNAL|CALTRANS)/);
      expect(t).not.toMatch(/RRFB|RADAR|MESSAGE|PENDING|FUTURE|FLASHER/);
    }
    expect(signals.count).toBeGreaterThan(1200);
  });

  it("matches nearly every signal to a graph intersection", () => {
    expect(eng.signalsMatched / signals.count).toBeGreaterThan(0.97);
  });

  it("finds signals at well-known signalised intersections", () => {
    // Matched on both street tokens in either order: the inventory writes
    // "16TH ST & VALENCIA" and "MARKET & SOUTH VAN NESS" (south of Market
    // it really is South Van Ness), so exact-string patterns miss them.
    const at = (a: string, b: string) =>
      signals.signals.some((s) => {
        const u = s.streets.toUpperCase();
        return u.includes(a) && u.includes(b);
      });
    expect(at("MARKET", "VAN NESS")).toBe(true);
    expect(at("VALENCIA", "16TH")).toBe(true);
    expect(at("MISSION", "24TH")).toBe(true);
  });
});

describe("fewer traffic lights", () => {
  const A = { lat: 37.7562, lng: -122.5102 }; // Ocean Beach
  const B = { lat: 37.7955, lng: -122.3937 }; // Ferry Building

  it("substantially cuts the lights on a cross-town ride", () => {
    const off = planRoutes(A, B).find((r) => r.profile === "fastest")!;
    const on = planRoutes(A, B, { fewerSignals: true }).find((r) => r.profile === "fastest")!;
    expect(on.trafficSignals).toBeLessThan(off.trafficSignals * 0.5);
  });

  it("does not take an absurd detour to do it", () => {
    const off = planRoutes(A, B).find((r) => r.profile === "fastest")!;
    const on = planRoutes(A, B, { fewerSignals: true }).find((r) => r.profile === "fastest")!;
    // Each light is priced at ~30s of riding; a detour beyond ~35% means
    // the per-intersection charge is being applied several times again.
    expect(on.distanceMeters).toBeLessThan(off.distanceMeters * 1.35);
  });

  it("charges a light only when riding into its intersection, never within it", () => {
    // ~7 OSM nodes fall within 18m of a typical signal. Charging every edge
    // that arrived at a flagged node billed one junction up to five times
    // and sent "fewer lights" on 44% detours. Asserted on the rule itself:
    // a symptom-level detour threshold let that regression through on
    // trips where the over-charge happened to cost less.
    let internal = 0;
    let entering = 0;
    for (const e of eng.graph.edges) {
      const a = eng.signalAtNode[e.from];
      const b = eng.signalAtNode[e.to];
      if (b >= 0 && a === b) {
        internal++;
        expect(edgeEntersSignal(eng, e.id)).toBe(false);
      }
      if (b >= 0 && a !== b) {
        entering++;
        expect(edgeEntersSignal(eng, e.id)).toBe(true);
      }
    }
    // The premise: intersections really do span several nodes.
    expect(internal).toBeGreaterThan(1000);
    expect(entering).toBeGreaterThan(1000);
  });

  it("counts each intersection once, not once per node", () => {
    // ~7 OSM nodes fall within 18m of a typical signal. A route through
    // one junction must count 1, not the number of nodes it touches.
    const r = planRoutes(A, B).find((x) => x.profile === "fastest")!;
    const km = r.distanceMeters / 1000;
    // Dense downtown blocks have roughly one signal every ~150m at worst.
    expect(r.trafficSignals / km).toBeLessThan(8);
  });

  it("never relaxes the safety profiles' flagged-area promise", () => {
    for (const r of planRoutes(A, B, { fewerSignals: true })) {
      if (r.profile === "fastest" || /best effort/i.test(r.label)) continue;
      expect(r.metersInFlaggedAreas).toBe(0);
    }
  });

  it("reports the setting on every route", () => {
    for (const r of planRoutes(A, B, { fewerSignals: true })) {
      expect(r.preferredFewerSignals).toBe(true);
    }
  });
});
