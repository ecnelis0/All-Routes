import type { StyleSpecification } from "maplibre-gl";

/**
 * Map styles for the 3D route tour.
 *
 * The brief was Google's photorealistic 3D. That is unavailable on this
 * project's key - `tile.googleapis.com` answers 403 PERMISSION_DENIED for
 * the 3D Tiles and session endpoints, `Map3DElement` fails to initialise,
 * and Street View Static is likewise not activated. All three need paid
 * SKUs enabled in Cloud Console.
 *
 * What we can get, free and keyless, is genuinely real imagery:
 *  - Esri World Imagery: actual aerial photography, ~0.3m/px over San
 *    Francisco. Individual buildings, cars and street markings are visible.
 *  - AWS Terrain Tiles: a real digital elevation model, so San Francisco's
 *    hills are actual terrain rather than a flat plane. This matters more
 *    here than almost anywhere - a bike route over Nob Hill and one around
 *    it look identical on flat ground.
 *  - OpenFreeMap / OpenMapTiles: OSM building footprints with heights, for
 *    extrusion, and street labels.
 *
 * Combining them gives photographic ground, real topography and 3D massing
 * - which is the substance of what the photorealistic ask was after.
 */

// Esri's World Imagery basemap. Free to use with attribution; this is the
// same service that backs "satellite" in countless OSS map apps.
const ESRI_IMAGERY =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIB =
  "Imagery &copy; Esri, Maxar, Earthstar Geographics, USDA, USGS, AeroGRID, IGN, and the GIS User Community";

// Mapzen/AWS "terrarium" encoded DEM, hosted on the AWS Open Data registry.
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRARIUM_ATTRIB = "Elevation: Mapzen / AWS Open Data";

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const OFM_TILEJSON = "https://tiles.openfreemap.org/planet";

export type TourStyleMode = "satellite" | "map";

/** Labels must use a font OpenFreeMap actually hosts; the MapLibre default stack 404s there. */
export const TOUR_FONT = ["Noto Sans Regular"];

/**
 * A satellite style: real aerial imagery on real terrain, with OSM
 * buildings extruded on top and street labels above that.
 *
 * Built by hand rather than fetched, so every source is one we have
 * verified reachable and the layer order is under our control. The vector
 * source is still OpenFreeMap's, since we only need its building and
 * street-name layers.
 */
export function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      satellite: {
        type: "raster",
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        maxzoom: 19,
        attribution: ESRI_ATTRIB,
      },
      terrain: {
        type: "raster-dem",
        tiles: [TERRARIUM],
        tileSize: 256,
        maxzoom: 14,
        // Terrarium packs elevation as (R*256 + G + B/256) - 32768 metres.
        // MapLibre needs telling; the default assumes Mapbox's encoding and
        // would render the city as violent noise.
        encoding: "terrarium",
        attribution: TERRARIUM_ATTRIB,
      },
      openmaptiles: { type: "vector", url: OFM_TILEJSON },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#0b1021" } },
      {
        id: "satellite",
        type: "raster",
        source: "satellite",
        paint: { "raster-opacity": 1 },
      },
      {
        // Extruded buildings over photography: the imagery already shows
        // roofs, so these are kept desaturated and slightly translucent to
        // read as massing rather than fighting the photo underneath.
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "render_height"], 8],
            0,
            "#8d93a6",
            40,
            "#a7adbd",
            120,
            "#c6cbd8",
          ],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.82,
        },
      },
      {
        id: "street-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "transportation_name",
        minzoom: 14,
        layout: {
          "text-field": ["get", "name"],
          "text-font": TOUR_FONT,
          "text-size": 12,
          "symbol-placement": "line",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.85)",
          "text-halo-width": 1.6,
        },
      },
    ],
    sky: {
      "sky-color": "#6ea4e0",
      "horizon-color": "#d8e4f0",
      "fog-color": "#cfd9e6",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.6,
      "fog-ground-blend": 0.2,
    },
  };
}

/** The illustrated vector style, for when the photography is too busy to read. */
export function mapStyleUrl(): string {
  return OPENFREEMAP_STYLE;
}

export const TERRAIN_SOURCE_ID = "terrain";
export const TERRAIN_EXAGGERATION = 1.25;

/**
 * Terrain source definition for the vector style, which does not ship one.
 * Exposed separately so both modes can show real topography.
 */
export function terrainSourceSpec() {
  return {
    type: "raster-dem" as const,
    tiles: [TERRARIUM],
    tileSize: 256,
    maxzoom: 14,
    encoding: "terrarium" as const,
    attribution: TERRARIUM_ATTRIB,
  };
}
