"use client";

import { useEffect, useRef } from "react";
import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildCameraPath, sampleCameraPath, type CameraKeyframe } from "@/lib/tour/camera";
import {
  TERRAIN_EXAGGERATION,
  TERRAIN_SOURCE_ID,
  satelliteStyle,
  terrainSourceSpec,
} from "@/lib/tour/style";
import type { LatLng } from "@/lib/types";

/**
 * Offscreen render target for server-side tour capture.
 *
 * Deliberately separate from the interactive tour. A frame grabber wants
 * the opposite properties from a UI: no chrome, no controls, no
 * animation loop, and above all the ability to be *seeked* to an exact
 * position and told when painting has finished.
 *
 * Capturing the interactive component instead would mean screenshotting a
 * live requestAnimationFrame loop, so frame timing would depend on how
 * fast the machine happened to be and the output would stutter
 * differently on every run. Here the renderer drives:
 *
 *   await window.__tourSeek(t)   // resolves once the map is idle at t
 *
 * which makes a render deterministic and reproducible.
 */

const ROUTE_COLOR: Record<string, string> = {
  fastest: "#94a3b8",
  balanced: "#fbbf24",
  safest: "#22c55e",
};

declare global {
  interface Window {
    __tourSeek?: (t: number) => Promise<void>;
    __tourReady?: boolean;
    __tourError?: string;
  }
}

export default function TourRenderPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const framesRef = useRef<CameraKeyframe[]>([]);
  // React's dev double-invoke runs this effect twice, and because the body
  // is async the cleanup fires before `map` is assigned - so `map?.remove()`
  // is a no-op and the first map is orphaned rather than torn down.
  const startedRef = useRef(false);
  // Deliberately a ref, not state: `status` exists purely so the render
  // script can read where initialisation got to. Holding it in state means
  // setting it synchronously inside the effect, which React flags as a
  // cascading render, and re-rendering the component is exactly what a
  // render target does not want mid-capture.
  const statusRef = useRef<HTMLSpanElement | null>(null);
  const setStatus = (v: string) => {
    if (statusRef.current) statusRef.current.textContent = v;
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const num = (k: string) => Number(params.get(k));
    const origin: LatLng = { lat: num("olat"), lng: num("olng") };
    const destination: LatLng = { lat: num("dlat"), lng: num("dlng") };
    const profile = params.get("profile") ?? "safest";

    if (![origin.lat, origin.lng, destination.lat, destination.lng].every(Number.isFinite)) {
      window.__tourError = "Missing or invalid olat/olng/dlat/dlng";
      setStatus("bad-params");
      return;
    }

    let map: MlMap | null = null;
    let cancelled = false;

    (async () => {
      setStatus("routing");
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, destination }),
      });
      const json = await res.json();
      if (!res.ok) {
        window.__tourError = json.error ?? `route failed (${res.status})`;
        setStatus("route-failed");
        return;
      }
      const route = (json.routes ?? []).find(
        (r: { profile: string }) => r.profile === profile
      );
      if (!route) {
        window.__tourError = `no route for profile ${profile}`;
        setStatus("no-profile");
        return;
      }
      if (cancelled || !containerRef.current) return;

      const path: LatLng[] = route.path;
      framesRef.current = buildCameraPath(path, 25);

      setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      setStatus("loading-map");

      map = new MlMap({
        container: containerRef.current,
        style: satelliteStyle(),
        center: [path[0].lng, path[0].lat],
        zoom: 17,
        pitch: 66,
        bearing: framesRef.current[0]?.bearing ?? 0,
        interactive: false,
        attributionControl: false,
        canvasContextAttributes: { preserveDrawingBuffer: true },
        // Frames are captured one at a time, so there is no animation to
        // drop; completeness matters far more than smoothness here.
        fadeDuration: 0,
      });
      mapRef.current = map;

      const onLoad = () => {
        if (!map) return;
        // `satelliteStyle()` ALREADY declares the terrain source, so
        // adding it again throws `Source "terrain" already exists`. An
        // earlier attempt to fix that by bailing out of this whole handler
        // when the source existed made it bail every single time, turning
        // a loud error into a silent hang - the renderer waited forever on
        // __tourReady with nothing logged. Guard only the add; always call
        // setTerrain, since that is what switches on 3D relief.
        if (!map.getSource(TERRAIN_SOURCE_ID)) {
          map.addSource(TERRAIN_SOURCE_ID, terrainSourceSpec());
        }
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });
        map.addSource("route", {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: { type: "LineString", coordinates: path.map((p) => [p.lng, p.lat]) },
            properties: {},
          },
        });
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
        map.addSource("pos", {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [path[0].lng, path[0].lat] },
            properties: {},
          },
        });
        map.addLayer({
          id: "pos-dot",
          type: "circle",
          source: "pos",
          paint: {
            "circle-radius": 10,
            "circle-color": "#2563eb",
            "circle-stroke-width": 3,
            "circle-stroke-color": "#ffffff",
          },
        });

        window.__tourSeek = (t: number) =>
          new Promise<void>((resolve) => {
            const m = mapRef.current;
            const frame = sampleCameraPath(framesRef.current, t);
            if (!m || !frame) return resolve();
            m.jumpTo({
              center: [frame.center.lng, frame.center.lat],
              bearing: frame.bearing,
              pitch: 66,
              zoom: 17,
            });
            (m.getSource("pos") as GeoJSONSource | undefined)?.setData({
              type: "Feature",
              geometry: { type: "Point", coordinates: [frame.center.lng, frame.center.lat] },
              properties: {},
            });
            // `idle` fires once every pending tile has loaded AND the frame
            // is painted. Screenshotting before it yields half-loaded
            // imagery, which is the usual cause of flickering output.
            if (m.loaded() && m.areTilesLoaded()) {
              m.once("render", () => resolve());
              m.triggerRepaint();
            } else {
              m.once("idle", () => resolve());
            }
          });

        window.__tourReady = true;
        setStatus("ready");
      };

      // `load` may already have fired by the time we attach, in which case
      // the listener would never run.
      if (map.loaded()) onLoad();
      else map.on("load", onLoad);

      map.on("error", (e) => {
        // Tile-level failures are expected and non-fatal; only record them.
        const msg = e.error?.message ?? "map error";
        if (!window.__tourError) window.__tourError = `tile: ${msg}`;
      });
    })();

    return () => {
      cancelled = true;
      // Read through the ref too: `map` may still be null here while the
      // async body is mid-flight, which is exactly how the orphaned-map
      // bug above arose.
      (map ?? mapRef.current)?.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-slate-950">
      <div ref={containerRef} className="h-full w-full" />
      <span ref={statusRef} data-testid="render-status" className="sr-only">
        init
      </span>
    </div>
  );
}
