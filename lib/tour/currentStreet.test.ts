import { describe, expect, it } from "vitest";
import { currentStreetAt, type StreetSpan } from "./currentStreet";

// A route like the real ones: named streets with unnamed gaps between.
const SPANS: StreetSpan[] = [
  { name: "Great Highway", startMeters: 0, endMeters: 145 },
  { name: "Irving Street", startMeters: 145, endMeters: 176 },
  { name: "La Playa Street", startMeters: 176, endMeters: 382 },
  // gap 382-900: unnamed park path
  { name: "John F Kennedy Drive", startMeters: 900, endMeters: 4200 },
  // gap 4200-4600
  { name: "The Embarcadero", startMeters: 4600, endMeters: 5000 },
];

describe("currentStreetAt", () => {
  it("returns the street you are actually on", () => {
    expect(currentStreetAt(SPANS, 100)).toBe("Great Highway");
    expect(currentStreetAt(SPANS, 200)).toBe("La Playa Street");
    expect(currentStreetAt(SPANS, 3376)).toBe("John F Kennedy Drive");
  });

  it("reports the most recent named street while on unnamed geometry", () => {
    // This is the bug that shipped: the fallback was spans[0], so two
    // miles inland through Golden Gate Park the label still read the
    // beach-front street the route began on.
    expect(currentStreetAt(SPANS, 500)).toBe("La Playa Street");
    expect(currentStreetAt(SPANS, 4400)).toBe("John F Kennedy Drive");
  });

  it("never reports the first street merely because nothing else matched", () => {
    // The specific wrong answer, pinned.
    expect(currentStreetAt(SPANS, 4400)).not.toBe("Great Highway");
    expect(currentStreetAt(SPANS, 500)).not.toBe("Great Highway");
  });

  it("returns null before any named street begins", () => {
    const later: StreetSpan[] = [{ name: "Somewhere", startMeters: 300, endMeters: 400 }];
    expect(currentStreetAt(later, 100)).toBeNull();
  });

  it("holds the last street past the end of the route", () => {
    expect(currentStreetAt(SPANS, 99_999)).toBe("The Embarcadero");
  });

  it("handles an empty span list", () => {
    expect(currentStreetAt([], 500)).toBeNull();
  });

  it("is stable across a full traversal - no flicker back to earlier streets", () => {
    // Walking forward, the reported street must never go backwards in the
    // span order; a regression to an earlier name is the visible symptom
    // of a bad fallback.
    const order = SPANS.map((s) => s.name);
    let lastIndex = -1;
    for (let m = 0; m <= 5200; m += 25) {
      const name = currentStreetAt(SPANS, m);
      if (!name) continue;
      const i = order.indexOf(name);
      expect(i, `went backwards to ${name} at ${m}m`).toBeGreaterThanOrEqual(lastIndex);
      lastIndex = i;
    }
  });
});
