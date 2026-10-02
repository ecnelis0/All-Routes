import { describe, expect, it } from "vitest";
import {
  activeAnnotation,
  buildAnnotations,
  type AvoidedArea,
  type ProtectedSpan,
} from "./annotations";

const PROTECTED: ProtectedSpan[] = [
  { tier: "fullyProtected", name: null, startMeters: 1183, endMeters: 1248 },
  { tier: "semiProtected", name: "Arguello Boulevard", startMeters: 6837, endMeters: 6930 },
  { tier: "fullyProtected", name: "Market Street", startMeters: 11000, endMeters: 11800 },
];

const AVOIDED: AvoidedArea[] = [
  { name: "Fillmore", atMeters: 9858, closestMeters: 240 },
  { name: "Tenderloin", atMeters: 11568, closestMeters: 639 },
];

describe("buildAnnotations", () => {
  const anns = buildAnnotations(PROTECTED, AVOIDED);

  it("produces one annotation per protected span and avoided area", () => {
    expect(anns).toHaveLength(PROTECTED.length + AVOIDED.length);
  });

  it("orders them by position along the route", () => {
    const at = anns.map((a) => a.atMeters);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it("distinguishes protected from buffered lanes", () => {
    const titles = anns.filter((a) => a.kind === "protected").map((a) => a.title);
    expect(titles).toContain("Protected bike lane");
    expect(titles).toContain("Buffered bike lane");
  });

  it("describes unnamed protected geometry rather than showing a blank", () => {
    // Park paths and separated cycleways frequently carry no street name.
    // "(unnamed)" or an empty caption reads as a bug.
    const unnamed = anns.find((a) => a.atMeters === 1183)!;
    expect(unnamed.detail).toBe("Separated path");
    expect(unnamed.detail).not.toMatch(/unnamed|null|undefined/i);
  });

  it("keeps a short protected lane on screen long enough to read", () => {
    // The first span is only 65m; at tour speed that would flash past.
    const short = anns.find((a) => a.atMeters === 1183)!;
    expect(short.untilMeters - short.atMeters).toBeGreaterThanOrEqual(180);
  });

  it("does not pad a long lane beyond where it actually ends", () => {
    const long = anns.find((a) => a.detail === "Market Street")!;
    expect(long.untilMeters).toBe(11800);
  });

  it("handles empty inputs", () => {
    expect(buildAnnotations([], [])).toEqual([]);
  });
});

describe("activeAnnotation", () => {
  const anns = buildAnnotations(PROTECTED, AVOIDED);

  it("returns nothing before the first event", () => {
    expect(activeAnnotation(anns, 0)).toBeNull();
  });

  it("shows a protected lane while riding it", () => {
    const a = activeAnnotation(anns, 6900);
    expect(a?.kind).toBe("protected");
    expect(a?.detail).toBe("Arguello Boulevard");
  });

  it("shows an avoidance as the route passes the area", () => {
    const a = activeAnnotation(anns, 9900);
    expect(a?.kind).toBe("avoided");
    expect(a?.detail).toBe("Fillmore");
  });

  it("clears once the event is behind you", () => {
    // Fillmore triggers at 9858 and should be gone well before Tenderloin.
    expect(activeAnnotation(anns, 10400)).toBeNull();
  });

  it("prefers the most recent event when two overlap", () => {
    // Market Street's lane spans 11000-11800 and Tenderloin is avoided at
    // 11568 - right in the middle of it. The newer event should win, or
    // the caption freezes on the lane and never mentions the avoidance.
    const a = activeAnnotation(anns, 11600);
    expect(a?.detail).toBe("Tenderloin");
  });

  it("never returns an annotation outside its own window", () => {
    for (let m = 0; m <= 13000; m += 50) {
      const a = activeAnnotation(anns, m);
      if (!a) continue;
      expect(m).toBeGreaterThanOrEqual(a.atMeters);
      expect(m).toBeLessThanOrEqual(a.untilMeters);
    }
  });
});
