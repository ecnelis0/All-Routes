import { describe, expect, it } from "vitest";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
  neighborhoodRiskLabel,
} from "./sfDangerousNeighborhoods";
import { DEMO_CITY } from "../mockData";

describe("SF_DANGEROUS_NEIGHBORHOODS", () => {
  it("covers every flagged area exactly once", () => {
    const expected = [
      "Tenderloin",
      "SoMa (South of Market)",
      "Civic Center",
      "Bayview–Hunters Point",
      "Western Addition",
      "Fillmore",
      "Mission District",
      "Visitacion Valley",
      "Excelsior",
      "Outer Mission",
      "Potrero Hill",
      "Chinatown",
      "Downtown",
      "Union Square",
      "Oceanview",
      "Portola",
      "Bernal Heights",
    ];
    expect(SF_DANGEROUS_NEIGHBORHOODS.map((n) => n.name).sort()).toEqual([...expected].sort());
  });

  it("has unique ids", () => {
    const ids = SF_DANGEROUS_NEIGHBORHOODS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("places every area inside San Francisco", () => {
    // A transposed or sign-flipped coordinate renders a circle in the ocean
    // or another state, and nothing else in the pipeline would complain -
    // the router would simply stop avoiding that neighbourhood.
    for (const n of SF_DANGEROUS_NEIGHBORHOODS) {
      expect(n.center.lat, `${n.name} latitude`).toBeGreaterThan(37.70);
      expect(n.center.lat, `${n.name} latitude`).toBeLessThan(37.84);
      expect(n.center.lng, `${n.name} longitude`).toBeGreaterThan(-122.52);
      expect(n.center.lng, `${n.name} longitude`).toBeLessThan(-122.35);
    }
  });

  it("uses plausible neighbourhood-scale radii", () => {
    // Below ~250m is an intersection, not a district (that is what
    // KNOWN_DANGEROUS_LOCATIONS is for); above ~1500m would swallow half
    // the city and make avoidance meaningless.
    for (const n of SF_DANGEROUS_NEIGHBORHOODS) {
      expect(n.radiusMeters, `${n.name} radius`).toBeGreaterThanOrEqual(250);
      expect(n.radiusMeters, `${n.name} radius`).toBeLessThanOrEqual(1500);
    }
  });

  it("keeps risk within the 0-100 score scale the model shares", () => {
    for (const n of SF_DANGEROUS_NEIGHBORHOODS) {
      expect(n.risk).toBeGreaterThan(0);
      expect(n.risk).toBeLessThanOrEqual(100);
    }
  });

  it("sits within the demo city's rendered bounds", () => {
    for (const n of SF_DANGEROUS_NEIGHBORHOODS) {
      expect(n.center.lat).toBeLessThan(DEMO_CITY.bounds.north + 0.03);
      expect(n.center.lat).toBeGreaterThan(DEMO_CITY.bounds.south - 0.03);
    }
  });
});

describe("risk colour ramp", () => {
  it("gives each band a distinct colour", () => {
    const colours = new Set([85, 70, 55].map(neighborhoodRiskColor));
    expect(colours.size).toBe(3);
  });

  it("agrees with the label for the same risk", () => {
    // The legend renders label and swatch from these two functions
    // independently; if their thresholds ever drift, the legend lies.
    for (const risk of [0, 54, 55, 64, 65, 79, 80, 100]) {
      const sameBand = {
        Severe: "#dc2626",
        High: "#f97316",
        Elevated: "#facc15",
      }[neighborhoodRiskLabel(risk)];
      expect(neighborhoodRiskColor(risk)).toBe(sameBand);
    }
  });
});
