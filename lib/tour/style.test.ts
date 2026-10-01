import { describe, expect, it } from "vitest";
import {
  TERRAIN_EXAGGERATION,
  TOUR_FONT,
  satelliteStyle,
  terrainSourceSpec,
} from "./style";

describe("satelliteStyle", () => {
  const style = satelliteStyle();

  it("is a version 8 style with the three sources the tour needs", () => {
    expect(style.version).toBe(8);
    expect(Object.keys(style.sources).sort()).toEqual([
      "openmaptiles",
      "satellite",
      "terrain",
    ]);
  });

  it("uses real aerial imagery, not an illustrated basemap", () => {
    const sat = style.sources.satellite as { tiles?: string[]; attribution?: string };
    expect(sat.tiles?.[0]).toMatch(/World_Imagery/);
    // Esri's licence requires attribution; shipping without it is a
    // licensing problem, not a cosmetic one.
    expect(sat.attribution).toMatch(/Esri/);
  });

  it("declares terrarium encoding on the DEM source", () => {
    // The default assumption is Mapbox's encoding. Feeding terrarium tiles
    // to a Mapbox-encoding reader does not error - it renders the city as
    // violent noise, which looks like a bug anywhere but here.
    const dem = style.sources.terrain as { encoding?: string; tiles?: string[] };
    expect(dem.encoding).toBe("terrarium");
    expect(dem.tiles?.[0]).toMatch(/terrarium/);
  });

  it("pins a font the glyph server actually hosts", () => {
    // Asserted as a literal, NOT against TOUR_FONT: comparing the constant
    // to itself passes no matter what it is set to, which is exactly how
    // an earlier version of this test let a bad font through. OpenFreeMap
    // serves Noto Sans; MapLibre's default stack ("Open Sans Regular,Arial
    // Unicode MS Regular") 404s there and silently drops every label -
    // verified against the live glyph endpoint.
    expect(TOUR_FONT).toEqual(["Noto Sans Regular"]);
    const labels = style.layers.find((l) => l.id === "street-labels");
    expect(labels).toBeDefined();
    const layout = (labels as { layout?: Record<string, unknown> }).layout;
    expect(layout?.["text-font"]).toEqual(["Noto Sans Regular"]);
    expect(style.glyphs).toMatch(/\{fontstack\}/);
  });

  it("draws imagery under buildings and buildings under labels", () => {
    // Layer order is paint order. Buildings beneath the photo would be
    // invisible; labels beneath buildings get swallowed by towers.
    const ids = style.layers.map((l) => l.id);
    expect(ids.indexOf("satellite")).toBeLessThan(ids.indexOf("buildings-3d"));
    expect(ids.indexOf("buildings-3d")).toBeLessThan(ids.indexOf("street-labels"));
  });

  it("extrudes buildings with a real height, not a constant", () => {
    const b = style.layers.find((l) => l.id === "buildings-3d") as {
      paint?: Record<string, unknown>;
    };
    expect(JSON.stringify(b.paint?.["fill-extrusion-height"])).toContain("render_height");
  });

  it("includes a sky so the horizon is not raw background colour", () => {
    expect(style.sky).toBeDefined();
  });

  it("returns a fresh object each call", () => {
    // The component hands this to setStyle on every mode switch; a shared
    // mutable object would accumulate MapLibre's internal edits.
    expect(satelliteStyle()).not.toBe(satelliteStyle());
  });
});

describe("terrainSourceSpec", () => {
  it("matches the satellite style's DEM source so both modes agree", () => {
    const standalone = terrainSourceSpec();
    const inStyle = satelliteStyle().sources.terrain as Record<string, unknown>;
    expect(standalone.encoding).toBe(inStyle.encoding);
    expect(standalone.tiles).toEqual(inStyle.tiles);
  });

  it("uses a sane exaggeration", () => {
    // Below 1 flattens the hills this exists to show; far above it turns
    // San Francisco into the Alps.
    expect(TERRAIN_EXAGGERATION).toBeGreaterThanOrEqual(1);
    expect(TERRAIN_EXAGGERATION).toBeLessThanOrEqual(2);
  });
});
