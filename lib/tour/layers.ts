import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { TERRAIN_EXAGGERATION, TERRAIN_SOURCE_ID, TOUR_FONT, terrainSourceSpec } from "./style";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
} from "../data/sfDangerousNeighborhoods";
import type { LatLng } from "../types";

/**
 * THE SINGLE DEFINITION OF HOW A TOUR LOOKS.
 *
 * Two things render tours: the interactive `Route3DTour` and the
 * offscreen `/render/tour` page used for server-side capture. They had
 * drifted badly - the render page used a different camera (zoom 17 /
 * pitch 66 against 16.4 / 58), had no cyclist, no traffic, and none of
 * the LiDAR buildings - so a rendered video looked nothing like the thing
 * on screen. The vector-tile building layer and the LiDAR building layer
 * had also diverged in opacity, which showed as a visible seam wherever
 * both were drawn.
 *
 * Everything visual therefore lives here and both consumers call
 * `addTourLayers`. Adding a layer in one place and forgetting the other
 * is the failure this module exists to prevent.
 */

/**
 * Camera framing.
 *
 * Pulled back from a closer 17 / 66. At street level in the Financial
 * District the towers are 150-200m and the camera ends up among them,
 * with the route, rider and traffic all hidden behind a wall of building.
 * This clears most massing while still reading as a street-level
 * fly-through in the low-rise districts that are most of the city.
 */
export const FLY_ZOOM = 16.4;
export const FLY_PITCH = 58;

export const ROUTE_COLOR: Record<string, string> = {
  fastest: "#94a3b8",
  balanced: "#fbbf24",
  safest: "#22c55e",
};

export function routeColor(profile: string): string {
  return ROUTE_COLOR[profile] ?? "#38bdf8";
}

/**
 * Building appearance, shared by the vector-tile layer and the LiDAR
 * layer so the two are indistinguishable where they meet.
 *
 * Opaque, deliberately. At 0.85 every tower in a dense block stacks its
 * translucent faces on the ones behind and downtown turns into a milky
 * wash with no readable massing. Solid surfaces also let the renderer
 * depth-cull, which is faster.
 */
export function buildingPaint(heightExpr: ExpressionSpecification | string) {
  return {
    "fill-extrusion-color": [
      "interpolate",
      ["linear"],
      typeof heightExpr === "string" ? ["get", heightExpr] : heightExpr,
      0,
      "#8d93a6",
      40,
      "#a7adbd",
      120,
      "#c9cedb",
    ] as ExpressionSpecification,
    "fill-extrusion-height":
      typeof heightExpr === "string"
        ? (["get", heightExpr] as ExpressionSpecification)
        : heightExpr,
    "fill-extrusion-base": 0,
    "fill-extrusion-opacity": 1,
    "fill-extrusion-vertical-gradient": true,
  };
}

/** Circle approximated as a polygon ring; `fill-extrusion` has no circle primitive. */
export function circlePolygon(center: LatLng, radiusMeters: number, sides = 48): [number, number][] {
  const ring: [number, number][] = [];
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return ring;
}

export interface TourLayerOptions {
  path: LatLng[];
  profile: string;
  /** Flagged-area slabs are useful in the interactive tour, noise in a short clip. */
  includeDangerAreas?: boolean;
  includeTraffic?: boolean;
}

/**
 * Adds terrain, flagged areas, the route, endpoints, traffic and the
 * rider. Idempotent, because `setStyle` discards everything and this gets
 * called again to rebuild.
 */
export function addTourLayers(map: MlMap, opts: TourLayerOptions) {
  const { path, profile, includeDangerAreas = true, includeTraffic = true } = opts;
  const colour = routeColor(profile);

  if (!map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, terrainSourceSpec());
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });

  if (includeDangerAreas && !map.getSource("danger-areas")) {
    map.addSource("danger-areas", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: SF_DANGEROUS_NEIGHBORHOODS.map((a) => ({
          type: "Feature" as const,
          geometry: {
            type: "Polygon" as const,
            coordinates: [circlePolygon(a.center, a.radiusMeters)],
          },
          properties: { name: a.name, color: neighborhoodRiskColor(a.risk), risk: a.risk },
        })),
      },
    });
  }
  if (includeDangerAreas && !map.getLayer("danger-fill")) {
    map.addLayer({
      id: "danger-fill",
      type: "fill-extrusion",
      source: "danger-areas",
      paint: {
        "fill-extrusion-color": ["get", "color"],
        // A low slab, not a tall volume: tall translucent boxes over
        // photography hide the streets the tour exists to show.
        "fill-extrusion-height": 18,
        "fill-extrusion-opacity": 0.26,
      },
    });
  }

  if (!map.getSource("route")) {
    map.addSource("route", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: path.map((p) => [p.lng, p.lat]) },
        properties: {},
      },
    });
  }
  // Three stacked lines: soft glow, dark casing, then the route. A single
  // stroke disappears against both pale concrete and dark shadow.
  if (!map.getLayer("route-glow")) {
    map.addLayer({
      id: "route-glow",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colour, "line-width": 22, "line-blur": 15, "line-opacity": 0.5 },
    });
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0f172a", "line-width": 11, "line-opacity": 0.9 },
    });
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colour, "line-width": 6 },
    });
  }

  if (!map.getSource("endpoints")) {
    map.addSource("endpoints", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [path[0].lng, path[0].lat] },
            properties: { label: "A" },
          },
          {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [path[path.length - 1].lng, path[path.length - 1].lat],
            },
            properties: { label: "B" },
          },
        ],
      },
    });
  }
  if (!map.getLayer("endpoint-dots")) {
    map.addLayer({
      id: "endpoint-dots",
      type: "circle",
      source: "endpoints",
      paint: {
        "circle-radius": 9,
        "circle-color": "#0f172a",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ffffff",
      },
    });
    map.addLayer({
      id: "endpoint-labels",
      type: "symbol",
      source: "endpoints",
      layout: {
        "text-field": ["get", "label"],
        "text-font": TOUR_FONT,
        "text-size": 11,
        "text-offset": [0, 0.1],
      },
      paint: { "text-color": "#ffffff" },
    });
  }

  // Traffic under the rider, so a car can never hide the rider.
  if (includeTraffic) {
    if (!map.getSource("traffic")) {
      map.addSource("traffic", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getLayer("traffic-cars")) {
      map.addLayer({
        id: "traffic-cars",
        type: "symbol",
        source: "traffic",
        layout: {
          "icon-image": ["case", ["==", ["get", "oncoming"], 1], "car-oncoming", "car-with"],
          "icon-rotate": ["get", "bearing"],
          // Lie flat on the road and turn with the map, rather than
          // facing the camera like a billboard.
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.35, 17, 0.8, 19, 1.1],
        },
      });
    }
  }

  if (!map.getSource("tour-position")) {
    map.addSource("tour-position", {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: { type: "Point", coordinates: [path[0].lng, path[0].lat] },
        properties: { bearing: 0 },
      },
    });
  }
  if (!map.getLayer("tour-dot")) {
    map.addLayer({
      id: "tour-dot",
      type: "symbol",
      source: "tour-position",
      layout: {
        "icon-image": "cyclist",
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.4, 17, 0.75, 19, 1],
      },
    });
  }
}

/**
 * Adds or updates the LiDAR building layer, and hides the generalised
 * vector-tile buildings only when coverage came back complete.
 *
 * Partial coverage with the tiles hidden leaves holes where whole
 * neighbourhoods should be, which is worse than the tiles it replaced.
 */
export function applyRealBuildings(
  map: MlMap,
  geojson: GeoJSON.FeatureCollection,
  complete: boolean
) {
  if (!map.getSource("sf-buildings")) {
    map.addSource("sf-buildings", { type: "geojson", data: geojson });
    map.addLayer({
      id: "sf-buildings-3d",
      type: "fill-extrusion",
      source: "sf-buildings",
      paint: buildingPaint("height"),
    });
  } else {
    (map.getSource("sf-buildings") as GeoJSONSource).setData(geojson);
  }

  if (map.getLayer("buildings-3d")) {
    map.setLayoutProperty("buildings-3d", "visibility", complete ? "none" : "visible");
  }

  // Keep what the tour is about above the city it flies through;
  // fill-extrusion otherwise paints over ground-level geometry.
  for (const id of ["route-glow", "route-casing", "route-line", "traffic-cars", "tour-dot"]) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}
