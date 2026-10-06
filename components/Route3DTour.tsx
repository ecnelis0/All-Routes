"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  buildCameraPath,
  pathBounds,
  sampleCameraPath,
  type CameraKeyframe,
} from "@/lib/tour/camera";
import { mapStyleUrl, satelliteStyle, type TourStyleMode } from "@/lib/tour/style";
import {
  FLY_PITCH,
  FLY_ZOOM,
  ROUTE_COLOR,
  addTourLayers,
  applyRealBuildings,
} from "@/lib/tour/layers";
import { currentStreetAt } from "@/lib/tour/currentStreet";
import { fetchCorridorBuildings } from "@/lib/tour/buildings";
import { makeCarIcon, makeCyclistIcon } from "@/lib/tour/icons";
import {
  cumulativeDistances,
  layOutTraffic,
  trafficAt,
  type TrafficRoadClass,
  type TrafficVehicle,
} from "@/lib/tour/traffic";
import {
  activeAnnotation,
  buildAnnotations,
  type AvoidedArea,
  type ProtectedSpan,
} from "@/lib/tour/annotations";
import type { StreetSpan } from "@/lib/tour/currentStreet";
import type { LatLng } from "@/lib/types";
import { ROUTE_PROFILES } from "@/lib/routing/cost";

/**
 * Cinematic 3D fly-through of a route, over real aerial imagery and real
 * terrain.
 *
 * The layout is deliberately full-bleed: the map fills the whole surface
 * and every control floats over it, fading away while the tour plays.
 * An earlier version framed the map between a header and footer bar,
 * which both ate vertical space and made it read as a widget rather than
 * a view of the city.
 *
 * See `lib/tour/style.ts` for why this is not Google photorealistic 3D
 * (Map Tiles, 3D Tiles and Street View are all un-activated on this
 * project's key) and what genuinely-real imagery we use instead.
 */

// Must match the option names in the sidebar (ROUTE_PROFILES in
// lib/routing/cost.ts) - these drifted once, and the tour called the
// "Safest + bike lanes" route "Safest".
const PROFILE_LABEL: Record<string, string> = Object.fromEntries(
  Object.values(ROUTE_PROFILES).map((p) => [p.id, p.label])
);

interface Props {
  path: LatLng[];
  profile: string;
  streetSpans?: StreetSpan[];
  classSpans?: { roadClass: string; startMeters: number; endMeters: number }[];
  /** Ground elevation at each vertex of `path`, for climb highlighting. */
  pathElevations?: number[];
  protectedSpans?: ProtectedSpan[];
  avoidedNearby?: AvoidedArea[];
  onClose: () => void;
}

/**
 * Target wall-clock length of the tour, in seconds. Scaled to the route
 * rather than flown at a fixed ground speed: at a realistic 7 m/s a 17km
 * route takes 40 minutes to watch, which is a commute, not a tour.
 */
const TOUR_TARGET_SECONDS = 50;
const TOUR_MIN_SECONDS = 18;
const TOUR_MAX_SECONDS = 100;

function tourDurationSeconds(totalMeters: number): number {
  const scaled = TOUR_TARGET_SECONDS * Math.sqrt(Math.max(1, totalMeters) / 5000);
  return Math.min(TOUR_MAX_SECONDS, Math.max(TOUR_MIN_SECONDS, scaled));
}


export default function Route3DTour({
  path,
  profile,
  streetSpans = [],
  classSpans = [],
  pathElevations,
  protectedSpans = [],
  avoidedNearby = [],
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const framesRef = useRef<CameraKeyframe[]>([]);
  const pathRef = useRef<LatLng[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  // Progress lives in a ref as well as state: the animation loop reads and
  // writes it every frame, and routing that through React state would both
  // lag a frame behind and re-render 60 times a second.
  const progressRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState(false);
  const [mode, setMode] = useState<TourStyleMode>("satellite");
  const [totalMeters, setTotalMeters] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [realBuildings, setRealBuildings] = useState<number | null>(null);
  const [showTraffic, setShowTraffic] = useState(true);
  // Mirrors trafficRef.current.length as state: the render needs to know
  // whether any traffic exists, and reading a ref during render is both a
  // React violation and genuinely stale (refs do not trigger re-renders).
  const [trafficCount, setTrafficCount] = useState(0);
  const trafficRef = useRef<TrafficVehicle[]>([]);
  const cumRef = useRef<number[]>([]);
  const elapsedRef = useRef(0);
  const buildingsRef = useRef<Awaited<ReturnType<typeof fetchCorridorBuildings>> | null>(null);

  const metersDone = totalMeters * progress;
  const currentStreet = currentStreetAt(streetSpans, metersDone);
  const annotations = useMemo(
    () => buildAnnotations(protectedSpans, avoidedNearby),
    [protectedSpans, avoidedNearby]
  );
  const callout = activeAnnotation(annotations, metersDone);

  const applyCamera = useCallback((t: number) => {
    const map = mapRef.current;
    const frame = sampleCameraPath(framesRef.current, t);
    if (!map || !frame) return;
    map.jumpTo({
      center: [frame.center.lng, frame.center.lat],
      bearing: frame.bearing,
      pitch: FLY_PITCH,
      zoom: FLY_ZOOM,
    });
    const src = map.getSource("tour-position") as GeoJSONSource | undefined;
    src?.setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: [frame.center.lng, frame.center.lat] },
      // The camera already faces along the route, so the rider drawn at
      // the centre must face the same way or it looks like it is sliding
      // sideways down the street.
      properties: { bearing: frame.bearing },
    });

    const traffic = map.getSource("traffic") as GeoJSONSource | undefined;
    if (traffic && trafficRef.current.length > 0) {
      traffic.setData(
        trafficAt(
          trafficRef.current,
          pathRef.current,
          cumRef.current,
          elapsedRef.current,
          frame.distanceMeters
        )
      );
    }
  }, []);

  /** Rebuilt after a style switch, since `setStyle` discards everything we added. */
  /** Rebuilt after a style switch, since `setStyle` discards everything we added. */
  const addOverlays = useCallback(
    (map: MlMap) => {
      for (const [name, oncoming] of [
        ["car-with", false],
        ["car-oncoming", true],
      ] as const) {
        if (!map.hasImage(name)) {
          const img = makeCarIcon(oncoming);
          if (img) map.addImage(name, img, { pixelRatio: 2 });
        }
      }
      if (!map.hasImage("cyclist")) {
        const img = makeCyclistIcon();
        if (img) map.addImage("cyclist", img, { pixelRatio: 2 });
      }
      addTourLayers(map, { path, profile, pathElevations });
    },
    [path, profile, pathElevations]
  );

  // --- map setup ---------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || path.length < 2) return;

    // Under Turbopack MapLibre's own worker URL resolution lands on a path
    // that does not exist, and the map dies with "Worker failed to load".
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    framesRef.current = buildCameraPath(path, 25);
    pathRef.current = path;
    cumRef.current = cumulativeDistances(path);
    // Deterministic: the same route lays out the same traffic every time,
    // so replays and screenshots stay comparable.
    trafficRef.current = layOutTraffic(
      classSpans.map((c) => ({
        startMeters: c.startMeters,
        endMeters: c.endMeters,
        roadClass: c.roadClass as TrafficRoadClass,
      }))
    );
    setTrafficCount(trafficRef.current.length);
    setTotalMeters(framesRef.current[framesRef.current.length - 1]?.distanceMeters ?? 0);

    const map = new MlMap({
      container: containerRef.current,
      style: satelliteStyle(),
      center: [path[0].lng, path[0].lat],
      zoom: 15,
      pitch: 50,
      bearing: framesRef.current[0]?.bearing ?? 0,
      attributionControl: { compact: true },
      // Keeps the WebGL drawing buffer readable after each frame, so
      // screenshots and readPixels return what is on screen. Without it
      // both come back black at random.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      maxPitch: 80,
    });
    mapRef.current = map;

    map.on("error", (e) => {
      const msg = e.error?.message ?? "";
      // Individual tiles fail routinely. Treating any of those as fatal
      // replaces a working map with an error screen; only a style-level
      // failure is unrecoverable.
      const isTileLevel =
        Boolean((e as unknown as { sourceId?: string }).sourceId) ||
        /tile|fetch|abort|network|204|404|50\d/i.test(msg);
      if (isTileLevel) {
        setTileWarning(true);
        return;
      }
      setFatalError(msg || "The 3D basemap failed to load.");
    });

    const abort = new AbortController();

    map.on("load", () => {
      addOverlays(map);
      const b = pathBounds(path);
      if (b) map.fitBounds(b, { padding: 70, pitch: 40, duration: 0 });
      setReady(true);

      // Swap the generalised vector-tile buildings for San Francisco's own
      // LiDAR-measured footprints along this corridor. Done after the map
      // is usable rather than before, so the tour is never blocked on a
      // third-party dataset - if it never arrives the tile buildings
      // stand and the view is merely less complete.
      void fetchCorridorBuildings(path, abort.signal)
        .then((result) => {
          buildingsRef.current = result;
          if (abort.signal.aborted || result.count === 0) return;
          const m = mapRef.current;
          if (!m) return;
          // Do NOT gate on isStyleLoaded(). With terrain and several
          // sources streaming it stays false for a long time and flaps,
          // so an earlier version fetched 1,458 buildings successfully
          // and then silently threw them away - the tour kept the
          // generalised tile buildings and nothing said why. Being inside
          // the `load` handler already guarantees layers can be added; if
          // the style is momentarily busy, wait for idle rather than
          // discard the work.
          const apply = () => {
            applyRealBuildings(m, result.geojson, !result.partial);
            setRealBuildings(result.count);
          };
          if (m.isStyleLoaded()) apply();
          else m.once("idle", apply);
        })
        .catch(() => {
          /* tile buildings remain; nothing to surface */
        });
    });

    return () => {
      abort.abort();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, [path, classSpans, addOverlays]);

  // --- chrome auto-hide --------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    // Fade the controls out shortly after playback starts so the city, not
    // the UI, is what you are looking at. Any pointer movement brings them
    // back - see wakeChrome.
    //
    // Only ever *hides*. Showing again on pause is derived below rather
    // than set here: calling setState synchronously in an effect triggers
    // a cascading render, and the paused state is a pure function of
    // `playing` anyway.
    hideTimerRef.current = setTimeout(() => setChromeVisible(false), 1800);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [playing]);

  function wakeChrome() {
    if (!playing) return; // already visible by derivation
    setChromeVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setChromeVisible(false), 2200);
  }

  // --- style switching ---------------------------------------------------
  function toggleTraffic() {
    const map = mapRef.current;
    const next = !showTraffic;
    setShowTraffic(next);
    if (map?.getLayer("traffic-cars")) {
      map.setLayoutProperty("traffic-cars", "visibility", next ? "visible" : "none");
    }
  }

  function switchMode(next: TourStyleMode) {
    const map = mapRef.current;
    if (!map || next === mode) return;
    setMode(next);
    setReady(false);
    map.setStyle(next === "satellite" ? satelliteStyle() : mapStyleUrl());
    map.once("styledata", () => {
      addOverlays(map);
      // `setStyle` discarded the LiDAR buildings along with everything
      // else. Without this, switching Satellite -> Map -> Satellite
      // silently drops back to the generalised tile buildings and the
      // view stops matching the one before the toggle.
      const cached = buildingsRef.current;
      if (cached) applyRealBuildings(map, cached.geojson, !cached.partial);
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

      elapsedRef.current += dt;
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

  /**
   * Starts the tour from the beginning with a short descent from the
   * overview into street level, then hands over to the animation loop.
   *
   * The descent exists so the viewer keeps their bearings: cutting
   * straight from a whole-city overview to a rooftop-height camera is
   * disorienting, and they lose track of which end of the route they are
   * at. `flyTo` is used only here - during playback the camera is driven
   * frame by frame by `applyCamera`, because easing between keyframes
   * would fight the constant-speed traversal.
   */
  function startFromBeginning() {
    const map = mapRef.current;
    if (!map) return;
    progressRef.current = 0;
    setProgress(0);
    const frame = sampleCameraPath(framesRef.current, 0);
    if (!frame) return;
    map.flyTo({
      center: [frame.center.lng, frame.center.lat],
      bearing: frame.bearing,
      pitch: FLY_PITCH,
      zoom: FLY_ZOOM,
      duration: 1600,
      essential: true,
    });
    map.once("moveend", () => setPlaying(true));
  }

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (progressRef.current <= 0 || progressRef.current >= 1) startFromBeginning();
    else {
      applyCamera(progressRef.current);
      setPlaying(true);
    }
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
    if (map && b) map.fitBounds(b, { padding: 70, pitch: 40, duration: 900 });
  }

  const miDone = metersDone / 1609.34;
  const miTotal = totalMeters / 1609.34;
  // Controls are always on while paused; auto-hide applies only during
  // playback, so this is derived rather than stored.
  const showChrome = !playing || chromeVisible;
  const fade = showChrome ? "opacity-100" : "opacity-0";

  return (
    <div
      className="absolute inset-0 z-40 bg-slate-950"
      onPointerMove={wakeChrome}
      onPointerDown={wakeChrome}
    >
      {/*
        h-full, not `absolute inset-0`: maplibre-gl.css sets
        `.maplibregl-map { position: relative }` on this same element and
        loads after Tailwind, so at equal specificity it wins, `inset-0`
        stops applying, and the container collapses to 0 height.
      */}
      <div ref={containerRef} className="tour-map h-full w-full" />
      {/*
        Attribution is a licence requirement for Esri and OpenStreetMap, so
        it stays - but MapLibre renders it as a full-width bar that ate two
        lines across the bottom of the view. Shrunk and dimmed rather than
        removed.
      */}
      <style jsx global>{`
        /* Each callout animates in once; keyed on the event so a new one
           replays rather than silently swapping text in place. */
        .tour-callout {
          animation: tourCalloutIn 320ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes tourCalloutIn {
          from {
            opacity: 0;
            transform: translateY(-6px) scale(0.96);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .tour-callout {
            animation: none;
          }
        }
        .tour-map .maplibregl-ctrl-attrib {
          background: rgba(2, 6, 23, 0.55);
          color: rgba(226, 232, 240, 0.75);
          font-size: 9px;
          line-height: 1.25;
          padding: 1px 6px;
          max-width: 46vw;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          border-radius: 6px 0 0 0;
        }
        .tour-map .maplibregl-ctrl-attrib a {
          color: rgba(226, 232, 240, 0.85);
        }
        .tour-map .maplibregl-ctrl-bottom-right {
          bottom: 0;
        }
      `}</style>

      {/*
        Heads-up stays visible while playing: the street you are currently
        on is the narration of the tour, not a control. Only the buttons
        and transport bar fade.
      */}
      <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-1.5">
        <span
          className="w-fit rounded-full px-2.5 py-1 text-[11px] font-semibold text-slate-900 shadow-lg"
          style={{ background: ROUTE_COLOR[profile] ?? "#38bdf8" }}
        >
          {PROFILE_LABEL[profile] ?? profile} route
        </span>
        {currentStreet && (
          <span className="w-fit max-w-[22rem] truncate rounded-md bg-slate-950/70 px-2.5 py-1.5 text-sm font-medium text-white shadow-lg backdrop-blur">
            {currentStreet}
          </span>
        )}

        {/*
          The two claims the app exists to make, said out loud at the
          moment they happen rather than left to be inferred from the
          statistics panel afterwards.
        */}
        {callout && (
          <span
            key={`${callout.kind}-${callout.atMeters}`}
            className={`tour-callout mt-1 flex w-fit max-w-[24rem] items-center gap-2 rounded-lg px-3 py-2 shadow-xl backdrop-blur ${
              callout.kind === "protected"
                ? "bg-emerald-500/90 text-emerald-950"
                : "bg-amber-400/90 text-amber-950"
            }`}
          >
            <span aria-hidden className="text-base leading-none">
              {callout.kind === "protected" ? "\u{1F6E1}" : "\u{21AA}"}
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-[10px] font-bold uppercase tracking-wide opacity-80">
                {callout.title}
              </span>
              <span className="truncate text-sm font-semibold">{callout.detail}</span>
            </span>
          </span>
        )}
      </div>

      {/* --- floating controls --- */}
      <div
        className={`absolute right-4 top-4 flex items-center gap-2 transition-opacity duration-500 ${fade}`}
      >
        <div className="flex overflow-hidden rounded-full border border-white/20 bg-slate-950/70 backdrop-blur">
          {(["satellite", "map"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                mode === m ? "bg-white text-slate-900" : "text-slate-200 hover:bg-white/10"
              }`}
            >
              {m === "satellite" ? "Satellite" : "Map"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleTraffic}
          aria-pressed={showTraffic}
          className={`rounded-full border px-3 py-1.5 text-xs backdrop-blur transition-colors ${
            showTraffic
              ? "border-white/40 bg-white text-slate-900"
              : "border-white/20 bg-slate-950/70 text-slate-200 hover:bg-white/10"
          }`}
        >
          Traffic
        </button>
        <button
          type="button"
          onClick={overview}
          className="rounded-full border border-white/20 bg-slate-950/70 px-3 py-1.5 text-xs text-slate-200 backdrop-blur hover:bg-white/10"
        >
          Overview
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Exit 3D tour"
          className="rounded-full border border-white/20 bg-slate-950/70 px-3 py-1.5 text-xs text-slate-200 backdrop-blur hover:bg-white/10"
        >
          Close
        </button>
      </div>

      {/* --- floating transport bar --- */}
      <div
        className={`absolute bottom-5 left-1/2 flex w-[min(44rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-slate-950/70 px-3 py-2.5 shadow-2xl backdrop-blur transition-opacity duration-500 ${fade}`}
      >
        <button
          type="button"
          onClick={togglePlay}
          disabled={!ready}
          aria-label={playing ? "Pause tour" : "Play tour"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-slate-900 transition-transform hover:scale-105 disabled:opacity-40"
        >
          {playing ? (
            <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              <rect x="1.5" y="1" width="3" height="10" rx="1" />
              <rect x="7.5" y="1" width="3" height="10" rx="1" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
              <path d="M2.5 1.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1l-7.3-4.8a.6.6 0 0 0-.92.5Z" />
            </svg>
          )}
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
          className="h-1 flex-1 cursor-pointer accent-white"
        />
        <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-slate-200">
          {miDone.toFixed(2)} / {miTotal.toFixed(2)} mi
        </span>
      </div>

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
      {showTraffic && trafficCount > 0 && (
        <div
          className={`pointer-events-none absolute bottom-28 right-4 rounded bg-slate-950/70 px-2 py-1 text-[10px] text-slate-300 transition-opacity duration-500 ${fade}`}
        >
          {/*
            Said plainly whenever the cars are on screen. San Francisco
            publishes no per-street vehicle volumes, so this is an
            illustration keyed to real road classification - not counts,
            and not live.
          */}
          Traffic is illustrative · density by road class, not live data
        </div>
      )}
      {realBuildings !== null && (
        <div
          className={`pointer-events-none absolute bottom-20 right-4 rounded bg-slate-950/70 px-2 py-1 text-[10px] text-slate-300 transition-opacity duration-500 ${fade}`}
        >
          {realBuildings.toLocaleString()} buildings · SF LiDAR footprints
        </div>
      )}
      {tileWarning && !fatalError && (
        <div
          className={`pointer-events-none absolute bottom-20 left-4 rounded bg-slate-950/70 px-2 py-1 text-[10px] text-slate-300 transition-opacity duration-500 ${fade}`}
        >
          Some imagery tiles didn&apos;t load
        </div>
      )}
    </div>
  );
}

