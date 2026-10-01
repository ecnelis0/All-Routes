"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  buildCameraPath,
  pathBounds,
  sampleCameraPath,
  type CameraKeyframe,
} from "@/lib/tour/camera";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
} from "@/lib/data/sfDangerousNeighborhoods";
import type { LatLng } from "@/lib/types";

/**
 * 3D fly-through of a computed route: tilted camera, extruded buildings,
 * the route drawn on the ground, and the flagged neighbourhoods standing
 * up as translucent volumes so it is obvious where the route does and
 * does not go.
 *
 * WHY NOT GOOGLE: the original ask was Google's photorealistic 3D. This
 * project's key cannot do it - the Map Tiles API returns 403
 * PERMISSION_DENIED and `google.maps.maps3d.Map3DElement` fails to
 * initialise ("Attempted to load a 3D Map, but failed"). Photorealistic
 * 3D Tiles is a separate, paid SKU that has to be enabled in Cloud
 * Console. MapLibre with OpenFreeMap tiles needs no key, costs nothing,
 * and works today; the camera maths lives in `lib/tour/camera.ts` and is
 * renderer-agnostic, so moving to Google later is a contained change.
 */

// OpenFreeMap: free, no API key, no usage limits, OSM-derived vector
// tiles. Same underlying data as the routing graph, which keeps the 3D
// view and the router describing the same streets.
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

const ROUTE_COLOR: Record<string, string> = {
  fastest: "#64748b",
  balanced: "#f59e0b",
  safest: "#16a34a",
};

interface Props {
  path: LatLng[];
  profile: string;
  onClose: () => void;
}

/**
 * Target wall-clock length of the tour, in seconds.
 *
 * Scaled to the route rather than flown at a fixed ground speed: at a
 * realistic 7 m/s a 17km "safest" route takes 40 minutes to watch, which
 * is not a tour, it is a commute. Clamped so very short trips are not over
 * before the camera settles and very long ones do not drag.
 */
const TOUR_TARGET_SECONDS = 45;
const TOUR_MIN_SECONDS = 15;
const TOUR_MAX_SECONDS = 90;

function tourDurationSeconds(totalMeters: number): number {
  // Longer routes get proportionally more time, but sub-linearly.
  const scaled = TOUR_TARGET_SECONDS * Math.sqrt(Math.max(1, totalMeters) / 5000);
  return Math.min(TOUR_MAX_SECONDS, Math.max(TOUR_MIN_SECONDS, scaled));
}

export default function Route3DTour({ path, profile, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const framesRef = useRef<CameraKeyframe[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  // Progress is held in a ref as well as state: the animation loop reads and
  // writes it every frame, and routing that through React state would both
  // lag a frame behind and re-render the whole component 60 times a second.
  const progressRef = useRef(0);

  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);

  // Held in state rather than read off framesRef during render: a ref's
  // value is not tracked, so rendering from it is both a React violation
  // and a real staleness bug (the footer would show 0 until some other
  // state change happened to re-render).
  const [totalMeters, setTotalMeters] = useState(0);

  const applyCamera = useCallback((t: number) => {
    const map = mapRef.current;
    const frame = sampleCameraPath(framesRef.current, t);
    if (!map || !frame) return;
    map.jumpTo({
      center: [frame.center.lng, frame.center.lat],
      bearing: frame.bearing,
      pitch: 68,
      zoom: 17.2,
    });
    // Drive the "you are here" marker from the same frame so it can never
    // drift out of sync with the camera.
    const src = map.getSource("tour-position") as GeoJSONSource | undefined;
    src?.setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: [frame.center.lng, frame.center.lat] },
      properties: {},
    });
  }, []);

  // --- map setup ---------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || path.length < 2) return;

    // Point MapLibre at the worker we serve from /public rather than
    // letting it derive one from `import.meta.url`. Under Turbopack that
    // derivation resolves to a path that does not exist, and the map fails
    // with "Worker failed to load" on a blank canvas. See
    // scripts/copyMaplibreWorker.mjs.
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    framesRef.current = buildCameraPath(path, 25);
    setTotalMeters(framesRef.current[framesRef.current.length - 1]?.distanceMeters ?? 0);

    const map = new MlMap({
      container: containerRef.current,
      style: STYLE_URL,
      center: [path[0].lng, path[0].lat],
      zoom: 16,
      pitch: 60,
      bearing: framesRef.current[0]?.bearing ?? 0,
      attributionControl: { compact: true },
      // Keeps the WebGL drawing buffer readable after each frame. Costs a
      // little memory, and buys two things: screenshots/readPixels of the
      // map actually return what is on screen (without it both come back
      // black at random, which makes "is the 3D view rendering?"
      // unanswerable), and any future "export this tour as an image" is
      // possible at all. Note v6 moved this under canvasContextAttributes.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    mapRef.current = map;

    map.on("error", (e) => {
      // A style that fails to load leaves a blank black canvas with no
      // other signal - surface it rather than letting it look like a bug
      // in the route.
      const msg = e.error?.message ?? "Map failed to load";
      setStyleError(msg);
    });

    map.on("load", () => {
      // --- flagged neighbourhoods, as standing volumes ---
      map.addSource("danger-areas", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: SF_DANGEROUS_NEIGHBORHOODS.map((a) => ({
            type: "Feature" as const,
            geometry: { type: "Polygon" as const, coordinates: [circlePolygon(a.center, a.radiusMeters)] },
            properties: { name: a.name, color: neighborhoodRiskColor(a.risk), risk: a.risk },
          })),
        },
      });
      map.addLayer({
        id: "danger-fill",
        type: "fill-extrusion",
        source: "danger-areas",
        paint: {
          "fill-extrusion-color": ["get", "color"],
          // Height scales with risk so the worst areas are visibly taller -
          // readable at a glance from a tilted camera, where a flat colour
          // wash largely disappears under the buildings.
          "fill-extrusion-height": ["*", ["get", "risk"], 1.4],
          "fill-extrusion-opacity": 0.22,
        },
      });

      // --- buildings ---
      // OpenFreeMap's Liberty style carries OSM building footprints with a
      // render_height attribute; extruding them is what makes the view read
      // as a city rather than a tilted paper map.
      const buildingLayer = map.getStyle().layers?.find((l: { id: string }) => l.id.includes("building"));
      if (buildingLayer) {
        map.addLayer({
          id: "buildings-3d",
          source: "openmaptiles",
          "source-layer": "building",
          type: "fill-extrusion",
          minzoom: 13,
          paint: {
            "fill-extrusion-color": "#d6d8de",
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.9,
          },
        });
      }

      // --- the route ---
      map.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: path.map((p) => [p.lng, p.lat]) },
          properties: {},
        },
      });
      // Casing under the main line keeps the route readable against both
      // pale roads and dark building shadow.
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": 0.85 },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_COLOR[profile] ?? "#2563eb", "line-width": 6 },
      });

      // --- endpoints + moving position ---
      map.addSource("endpoints", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: { type: "Point", coordinates: [path[0].lng, path[0].lat] }, properties: { label: "A" } },
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [path[path.length - 1].lng, path[path.length - 1].lat] },
              properties: { label: "B" },
            },
          ],
        },
      });
      map.addLayer({
        id: "endpoint-dots",
        type: "circle",
        source: "endpoints",
        paint: { "circle-radius": 8, "circle-color": "#111827", "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" },
      });
      map.addLayer({
        id: "endpoint-labels",
        type: "symbol",
        source: "endpoints",
        layout: {
          "text-field": ["get", "label"],
          // Must name a font OpenFreeMap actually hosts. The MapLibre
          // default stack ("Open Sans Regular,Arial Unicode MS Regular")
          // 404s there, which silently drops every label.
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 0.1],
        },
        paint: { "text-color": "#ffffff" },
      });

      map.addSource("tour-position", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "Point", coordinates: [path[0].lng, path[0].lat] }, properties: {} },
      });
      map.addLayer({
        id: "tour-dot",
        type: "circle",
        source: "tour-position",
        paint: { "circle-radius": 9, "circle-color": "#2563eb", "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" },
      });

      // Open framing the whole route, so the viewer sees where they are
      // going before being dropped to street level.
      const b = pathBounds(path);
      if (b) map.fitBounds(b, { padding: 80, pitch: 45, duration: 0 });

      setReady(true);
    });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, [path, profile]);

  // --- playback ----------------------------------------------------------
  useEffect(() => {
    if (!playing || !ready) return;
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      const total = totalMeters;
      if (total > 0) {
        const next = progressRef.current + dt / tourDurationSeconds(total);
        if (next >= 1) {
          progressRef.current = 1;
          setProgress(1);
          applyCamera(1);
          setPlaying(false);
          return;
        }
        progressRef.current = next;
        setProgress(next);
        applyCamera(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, ready, applyCamera, totalMeters]);

  function startOrResume() {
    if (progressRef.current >= 1) {
      progressRef.current = 0;
      setProgress(0);
    }
    applyCamera(progressRef.current);
    setPlaying(true);
  }

  function scrub(value: number) {
    setPlaying(false);
    progressRef.current = value;
    setProgress(value);
    applyCamera(value);
  }

  const metersDone = Math.round(totalMeters * progress);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-slate-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-700 bg-slate-900 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">3D route tour</span>
          <span
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-900"
            style={{ background: ROUTE_COLOR[profile] ?? "#2563eb" }}
          >
            {profile}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      <div className="relative flex-1">
        {/*
          h-full, not `absolute inset-0`: maplibre-gl.css sets
          `.maplibregl-map { position: relative }` on this same element and
          loads after Tailwind, so at equal specificity it wins, `inset-0`
          stops applying, and the container collapses to 0 height (MapLibre
          then falls back to a 300px canvas). An explicit height does not
          depend on `position` at all.
        */}
        <div ref={containerRef} className="h-full w-full" />
        {!ready && !styleError && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
            Loading 3D view…
          </div>
        )}
        {styleError && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-300">
            Could not load the 3D basemap: {styleError}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-slate-700 bg-slate-900 px-4 py-2.5">
        <button
          type="button"
          onClick={() => (playing ? setPlaying(false) : startOrResume())}
          disabled={!ready}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {playing ? "Pause" : progress >= 1 ? "Replay" : "Play tour"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={progress}
          disabled={!ready}
          aria-label="Tour progress"
          onChange={(e) => scrub(Number(e.target.value))}
          className="flex-1 accent-blue-500"
        />
        <span className="w-28 text-right text-[11px] tabular-nums text-slate-300">
          {(metersDone / 1609.34).toFixed(2)} / {(totalMeters / 1609.34).toFixed(2)} mi
        </span>
      </div>
    </div>
  );
}

/**
 * Approximates a circle as a polygon ring for `fill-extrusion`, which has
 * no circle primitive. 48 sides is smooth at city zoom without bloating
 * the GeoJSON for 17 areas.
 */
function circlePolygon(center: LatLng, radiusMeters: number, sides = 48): [number, number][] {
  const ring: [number, number][] = [];
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return ring;
}
