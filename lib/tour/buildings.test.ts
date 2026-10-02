import { describe, expect, it } from "vitest";
import { corridorChunks } from "./buildings";
import type { LatLng } from "../types";

const SHORT: LatLng[] = [
  { lat: 37.7920, lng: -122.4030 },
  { lat: 37.7950, lng: -122.3990 },
];
// Ocean Beach -> Ferry Building: wider than the endpoint's per-request limit.
const CROSS_TOWN: LatLng[] = [
  { lat: 37.7562, lng: -122.5102 },
  { lat: 37.7955, lng: -122.3937 },
];

describe("corridorChunks", () => {
  it("covers a short route in a single request", () => {
    expect(corridorChunks(SHORT).length).toBe(1);
  });

  it("splits a cross-town route into several", () => {
    // The endpoint refuses boxes over 0.08 degrees a side; a cross-town
    // route spans more than that, so one request would simply 400.
    expect(corridorChunks(CROSS_TOWN).length).toBeGreaterThan(1);
  });

  it("keeps every chunk inside the endpoint's size limit", () => {
    for (const path of [SHORT, CROSS_TOWN]) {
      for (const c of corridorChunks(path)) {
        expect(c.north - c.south).toBeLessThanOrEqual(0.08);
        expect(c.east - c.west).toBeLessThanOrEqual(0.08);
      }
    }
  });

  it("covers the whole route plus a corridor margin", () => {
    const chunks = corridorChunks(CROSS_TOWN);
    const south = Math.min(...chunks.map((c) => c.south));
    const north = Math.max(...chunks.map((c) => c.north));
    const west = Math.min(...chunks.map((c) => c.west));
    const east = Math.max(...chunks.map((c) => c.east));
    for (const p of CROSS_TOWN) {
      expect(p.lat).toBeGreaterThan(south);
      expect(p.lat).toBeLessThan(north);
      expect(p.lng).toBeGreaterThan(west);
      expect(p.lng).toBeLessThan(east);
    }
    // Margin so buildings beside the route are included, not just under it.
    expect(Math.min(...CROSS_TOWN.map((p) => p.lat)) - south).toBeGreaterThan(0.001);
  });

  it("produces no gaps between adjacent chunks", () => {
    // A gap is a stripe of missing buildings down the middle of the tour.
    const chunks = corridorChunks(CROSS_TOWN, 0.05);
    const lats = [...new Set(chunks.map((c) => c.south))].sort((a, b) => a - b);
    for (let i = 1; i < lats.length; i++) {
      const prev = chunks.find((c) => c.south === lats[i - 1])!;
      expect(lats[i]).toBeLessThanOrEqual(prev.north + 1e-9);
    }
  });

  it("returns nothing for an empty path", () => {
    expect(corridorChunks([])).toEqual([]);
  });
});
