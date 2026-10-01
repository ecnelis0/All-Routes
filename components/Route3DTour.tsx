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
  TERRAIN_EXAGGERATION,
  TERRAIN_SOURCE_ID,
  TOUR_FONT,
  mapStyleUrl,
  satelliteStyle,
  terrainSourceSpec,
  type TourStyleMode,
} from "@/lib/tour/style";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
} from "@/lib/data/sfDangerousNeighborhoods";
import type { LatLng } from "@/lib/types";

/**
 * 3D fly-through of a computed route over real aerial imagery and real
 * terrain.
 *
 * See `lib/tour/style.ts` for why this is not Google photorealistic 3D
 * (Map Tiles, 3D Tiles and Street View are all un-activated on this
 * project's key) and what genuinely-real imagery we use instead.
 */

const ROUTE_COLOR: Record<string, string> = {
  fastest: "#94a3b8",
  balanced: "#fbbf24",
  safest: "#22c55e",
};

interface Props {
  path: LatLng[];
  profile: string;
  onClose: () => void;
}

/**
 * Target wall-clock length of the tour, in seconds. Scaled to the route
 * rather than flown at a fixed ground speed: at a realistic 7 m/s a 17km
 * route takes 40 minutes to watch, which is a commute, not a tour.
 */
const TOUR_TARGET_SECONDS = 45;
const TOUR_MIN_SECONDS = 15;
const TOUR_MAX_SECONDS = 90;

function tourDurationSeconds(totalMeters: number): number {
  const scaled = TOUR_TARGET_SECONDS * Math.sqrt(Math.max(1, totalMeters) / 5000);
  return Math.min(TOUR_MAX_SECONDS, Math.max(TOUR_MIN_SECONDS, scaled));
}

export default function Route3DTour({ path, profile, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const framesRef = useRef<CameraKeyframe[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  // Progress lives in a ref as well as state: the animation loop reads and
  // writes it every frame, and routing that through React state would both
  // lag a frame behind and re-render 60 times a second.
  const progressRef = useRef(0);

  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState(false);
  const [mode, setMode] = useState<TourStyleMode>("satellite");
  const [totalMeters, setTotalMeters] = useState(0);

  const applyCamera = useCallback((t: number) => {
    const map = mapRef.current;
    const frame = sampleCameraPath(framesRef.current, t);
    if (!map || !frame) return;
    map.jumpTo({
      center: [frame.center.lng, frame.center.lat],
      bearing: frame.bearing,
      pitch: 66,
      zoom: 17,
    });
    const src = map.getSource("tour-position") as GeoJSONSource | undefined;
    src?.setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: [frame.center.lng, frame.center.lat] },
      properties: {},
    });
  }, []);

  /**
   * Adds everything that sits on top of the basemap. Called on first load
   * and again after a style switch, because `setStyle` discards every
   * source and layer the application added.
   */
  const addOverlays = useCallback(
    (map: MlMap) => {
      if (!map.getSource(TERRAIN_SOURCE_ID)) {
        map.addSource(TERRAIN_SOURCE_ID, terrainSourceSpec());
      }
      // Real topography. San Francisco is the city where this matters most:
      // without it a route over Nob Hill and one around it look identical.
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });

      if (!map.getSource("danger-areas")) {
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
      if (!map.getLayer("danger-fill")) {
        map.addLayer({
          id: "danger-fill",
          type: "fill-extrusion",
          source: "danger-areas",
          paint: {
            "fill-extrusion-color": ["get", "color"],
            // A low slab rather than a tall volume: tall translucent boxes
            // over photography wash the imagery out and hide the very
            // streets the tour exists to show. Near ground level it reads
            // as a tinted zone you fly over.
            "fill-extrusion-height": 18,
            "fill-extrusion-opacity": 0.3,
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
      if (!map.getLayer("route-glow")) {
        // Three stacked lines: a soft wide glow, a dark casing, then the
        // route. Over aerial photography a single stroke disappears
        // against pale concrete and dark shadow alike.
        map.addLayer({
          id: "route-glow",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ROUTE_COLOR[profile] ?? "#38bdf8",
            "line-width": 20,
            "line-blur": 14,
            "line-opacity": 0.5,
          },
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
          paint: { "line-color": ROUTE_COLOR[profile] ?? "#38bdf8", "line-width": 6 },
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

      if (!map.getSource("tour-position")) {
        map.addSource("tour-position", {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [path[0].lng, path[0].lat] },
            properties: {},
          },
        });
      }
      if (!map.getLayer("tour-dot")) {
        map.addLayer({
          id: "tour-dot",
          type: "circle",
          source: "tour-position",
          paint: {
            "circle-radius": 10,
            "circle-color": "#2563eb",
            "circle-stroke-width": 3,
            "circle-stroke-color": "#ffffff",
          },
        });
      }
    },
    [path, profile]
  );

  // --- map setup ---------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || path.length < 2) return;

    // Point MapLibre at the worker we serve ourselves. Under Turbopack its
    // own `new URL(..., import.meta.url)` resolution lands on a path that
    // does not exist and the map dies with "Worker failed to load".
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    framesRef.current = buildCameraPath(path, 25);
    setTotalMeters(framesRef.current[framesRef.current.length - 1]?.distanceMeters ?? 0);

    const map = new MlMap({
      container: containerRef.current,
      style: satelliteStyle(),
      center: [path[0].lng, path[0].lat],
      zoom: 16,
      pitch: 60,
      bearing: framesRef.current[0]?.bearing ?? 0,
      attributionControl: { compact: true },
      // Keeps the WebGL drawing buffer readable after each frame, so
      // screenshots and readPixels return what is actually on screen.
      // Without it both come back black at random, which makes "is the 3D
      // view rendering?" unanswerable - a false signal that already cost
      // time once on this component.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      maxPitch: 80,
    });
    mapRef.current = map;

    map.on("error", (e) => {
      const msg = e.error?.message ?? "";
      // Individual tiles fail routinely: a gap in coverage, a transient
      // 5xx, a request cancelled by a fast pan. Treating any of those as
      // fatal (which an earlier version did) replaces a perfectly good map
      // with an error screen. Only failing to load the style itself is
      // unrecoverable.
      const isTileLevel =
        Boolean((e as unknown as { sourceId?: string }).sourceId) ||
        /tile|fetch|abort|network|204|404|50\d/i.test(msg);
      if (isTileLevel) {
        setTileWarning(true);
        return;
      }
      setFatalError(msg || "The 3D basemap failed to load.");
    });

    map.on("load", () => {
      addOverlays(map);
      const b = pathBounds(path);
      if (b) map.fitBounds(b, { padding: 70, pitch: 45, duration: 0 });
      setReady(true);
    });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, [path, addOverlays]);

  // --- style switching ---------------------------------------------------
  function switchMode(next: TourStyleMode) {
    const map = mapRef.current;
    if (!map || next === mode) return;
    setMode(next);
    setReady(false);
    map.setStyle(next === "satellite" ? satelliteStyle() : mapStyleUrl());
    // `setStyle` discards every source and layer we added, so they have to
    // be rebuilt once the new style settles.
    map.once("styledata", () => {
      addOverlays(map);
      applyCamera(progressRef.current);
      setReady(true);
    });
  }

  // --- playback ----------------------------------------------------------
  useEffect(() => {
    if (!playing || !ready) return;
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      if (totalMeters > 0) {
        const next = progressRef.current + dt / tourDurationSeconds(totalMeters);
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

  function overview() {
    setPlaying(false);
    const map = mapRef.current;
    const b = pathBounds(path);
    if (map && b) map.fitBounds(b, { padding: 70, pitch: 45, duration: 900 });
  }

  const metersDone = Math.round(totalMeters * progress);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-slate-950">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">3D route tour</span>
          <span
            className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-900"
            style={{ background: ROUTE_COLOR[profile] ?? "#38bdf8" }}
          >
            {profile}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-700">
            {(["satellite", "map"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  mode === m
                    ? "bg-slate-200 text-slate-900"
                    : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {m === "satellite" ? "Satellite" : "Map"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={overview}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
          >
            Overview
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>

      <div className="relative flex-1">
        {/*
          h-full, not `absolute inset-0`: maplibre-gl.css sets
          `.maplibregl-map { position: relative }` on this same element and
          loads after Tailwind, so at equal specificity it wins, `inset-0`
          stops applying, and the container collapses to 0 height (MapLibre
          then falls back to a 300px canvas).
        */}
        <div ref={containerRef} className="h-full w-full" />
        {!ready && !fatalError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/70 text-sm text-slate-200">
            Loading aerial imagery and terrain…
          </div>
        )}
        {fatalError && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-300">
            {fatalError}
          </div>
        )}
        {tileWarning && !fatalError && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-slate-900/80 px-2 py-1 text-[10px] text-slate-300">
            Some imagery tiles didn&apos;t load
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-slate-800 bg-slate-950 px-4 py-2.5">
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
