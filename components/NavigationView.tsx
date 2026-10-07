"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { satelliteStyle } from "@/lib/tour/style";
import { addTourLayers } from "@/lib/tour/layers";
import { makeCyclistIcon } from "@/lib/tour/icons";
import {
  buildManeuvers,
  cumulative,
  formatDistance,
  type Maneuver,
  type ManeuverType,
  type StreetSpanLike,
} from "@/lib/nav/instructions";
import {
  initialState,
  matchFix,
  type GpsFix,
  type MatchResult,
  type TrackerState,
} from "@/lib/nav/tracker";
import {
  CRUISE_SPEED_MPS,
  formatEta,
  pathFrom,
  simulatedFix,
} from "@/lib/nav/simulate";
import type { LatLng } from "@/lib/types";
import type { RouteDescription } from "@/lib/ui/routeDescription";
import { RouteDetailsToggle } from "@/components/RouteChoices";
import { alongPath } from "@/lib/ui/geometry";

/**
 * Turn-by-turn navigation for a confirmed route.
 *
 * Positions come from one of two sources that produce the same `GpsFix`:
 *
 *   - "gps":      the browser's geolocation API (`watchPosition`). Only
 *                 works in a secure context - https, or http://localhost.
 *                 A phone opening http://192.168.x.x is NOT secure and the
 *                 browser refuses location outright.
 *   - "simulate": a synthetic rider moving along the route, so the whole
 *                 flow (instructions, rerouting, arrival) can be exercised
 *                 on a desktop.
 *
 * Everything downstream of the fix - matching, instructions, rerouting -
 * is identical for both, which is what makes the simulation a real test
 * of the navigation and not a separate demo.
 */

export interface NavRoute {
  path: LatLng[];
  profile: string;
  streetSpans: StreetSpanLike[];
  pathElevations?: number[];
}

interface Props {
  route: NavRoute;
  destination: LatLng;
  source: "gps" | "simulate";
  avoidElevation: boolean;
  fewerSignals: boolean;
  onExit: () => void;
  /** What this route is and which choices it honoured, shown on demand. */
  details?: RouteDescription;
  /**
   * Stops of a rider-edited route. A reroute must still pass the ones not
   * yet reached, rather than replacing the rider's own route with a stock
   * one because they missed a turn.
   */
  waypoints?: LatLng[];
}

/** Heading-up follow camera. Closer and flatter than the tour: this is for reading the next corner. */
const NAV_ZOOM = 17.2;
const NAV_PITCH = 50;
/** Do not hammer the router: one reroute per this many ms at most. */
const REROUTE_COOLDOWN_MS = 8000;
const SIM_TICK_MS = 1000;

const TURN_ANGLE: Partial<Record<ManeuverType, number>> = {
  depart: 0,
  straight: 0,
  "slight-right": 45,
  right: 90,
  "sharp-right": 135,
  "slight-left": -45,
  left: -90,
  "sharp-left": -135,
  "u-turn": 180,
};

function TurnArrow({ type }: { type: ManeuverType }) {
  if (type === "arrive") {
    return (
      <svg viewBox="0 0 24 24" className="h-10 w-10" aria-hidden>
        <path
          d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  const angle = TURN_ANGLE[type] ?? 0;
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-10 w-10"
      aria-hidden
      style={{ transform: `rotate(${angle}deg)` }}
    >
      <path d="M12 3 5 11h4.5v10h5V11H19L12 3Z" fill="currentColor" />
    </svg>
  );
}

const GPS_WAITING = "Waiting for GPS…";
const GPS_UNAVAILABLE =
  "Your device could not determine a position. Move to open sky and try again.";
const GPS_TIMEOUT = "Waiting for a GPS fix timed out. Still trying…";
const GPS_MESSAGES = new Set([GPS_WAITING, GPS_UNAVAILABLE, GPS_TIMEOUT]);

function geoErrorMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) {
    return "Location permission was denied. Allow location for this site in your browser settings, then start again.";
  }
  if (err.code === err.POSITION_UNAVAILABLE) return GPS_UNAVAILABLE;
  return GPS_TIMEOUT;
}

export default function NavigationView({
  route: initialRoute,
  destination,
  source,
  avoidElevation,
  fewerSignals,
  onExit,
  details,
  waypoints,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);

  const [route, setRoute] = useState<NavRoute>(initialRoute);
  const cum = useMemo(() => cumulative(route.path), [route.path]);
  const maneuvers = useMemo(
    () => buildManeuvers(route.path, route.streetSpans),
    [route],
  );

  // The geolocation callback and the simulation timer outlive renders, so
  // they read the live route through refs rather than a stale closure.
  const routeRef = useRef({ path: route.path, cum, maneuvers });
  const trackerRef = useRef<TrackerState>(initialState());
  const lastFixRef = useRef<GpsFix | null>(null);
  const lastRerouteRef = useRef(0);
  const reroutingRef = useRef(false);
  const followRef = useRef(true);
  const simMetersRef = useRef(0);
  const driftRef = useRef(0);

  const [match, setMatch] = useState<MatchResult | null>(null);
  const [status, setStatus] = useState<string | null>(
    source === "gps" ? GPS_WAITING : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [rerouteCount, setRerouteCount] = useState(0);
  const [following, setFollowing] = useState(true);
  const [simSpeed, setSimSpeed] = useState(4);
  const [paused, setPaused] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  /** Wall-clock time of the latest fix; the arrival time is projected from it. */
  const [fixTime, setFixTime] = useState<number | null>(null);

  useEffect(() => {
    routeRef.current = { path: route.path, cum, maneuvers };
    trackerRef.current = initialState();
    simMetersRef.current = 0;
    driftRef.current = 0;
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("route") as GeoJSONSource | undefined;
    src?.setData({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: route.path.map((p) => [p.lng, p.lat]),
      },
      properties: {},
    });
    // Refreshes the climb highlighting for the new geometry.
    addTourLayers(map, {
      path: route.path,
      profile: route.profile,
      pathElevations: route.pathElevations,
      includeTraffic: false,
    });
  }, [route, cum, maneuvers]);

  const stopsRef = useRef<LatLng[] | undefined>(waypoints);

  const reroute = useCallback(
    async (from: GpsFix) => {
      const now = Date.now();
      if (
        reroutingRef.current ||
        now - lastRerouteRef.current < REROUTE_COOLDOWN_MS
      )
        return;
      reroutingRef.current = true;
      lastRerouteRef.current = now;
      setRerouting(true);
      try {
        // Stops already passed are dropped; the rest stay in order.
        const { path: currentPath } = routeRef.current;
        const remaining = (stopsRef.current ?? []).filter(
          (w) => alongPath(w, currentPath) > trackerRef.current.furthestMeters + 15,
        );
        const isCustom = stopsRef.current !== undefined;
        const res = await fetch(isCustom ? "/api/route/custom" : "/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origin: { lat: from.lat, lng: from.lng },
            destination,
            avoidElevation,
            fewerSignals,
            ...(isCustom ? { waypoints: remaining, profile: initialRoute.profile } : {}),
          }),
        });
        const raw = (await res.json()) as {
          routes?: (NavRoute & { profile: string })[];
          route?: NavRoute & { profile: string };
          error?: string;
        };
        const json = { ...raw, routes: raw.route ? [raw.route] : raw.routes };
        if (isCustom && res.ok) stopsRef.current = remaining;
        if (!res.ok || !json.routes?.length) {
          setStatus(
            json.error ??
              "Could not find a new route from here. Head back toward the line.",
          );
          return;
        }
        // Same safety profile the rider chose - a reroute must not quietly
        // swap "Safest" for "Fastest" because they missed a turn.
        const next =
          json.routes.find((r) => r.profile === initialRoute.profile) ??
          json.routes[0];
        setRoute({
          path: next.path,
          profile: next.profile,
          streetSpans: next.streetSpans,
          pathElevations: next.pathElevations,
        });
        setRerouteCount((n) => n + 1);
        // The old match describes the old line (still "off route"); drop it
        // so the banner does not flash a stale state before the next fix.
        setMatch(null);
        setStatus(null);
      } catch {
        setStatus("No connection - keep riding, will retry.");
      } finally {
        reroutingRef.current = false;
        setRerouting(false);
      }
    },
    [destination, avoidElevation, fewerSignals, initialRoute.profile],
  );

  const handleFix = useCallback(
    (fix: GpsFix) => {
      const { path, cum: c, maneuvers: m } = routeRef.current;
      // Animate the camera over the gap since the previous fix, so it
      // arrives just as the next one lands. A fixed 900ms is cut short and
      // lags behind on devices that report faster than once a second.
      const gap = lastFixRef.current
        ? fix.timestamp - lastFixRef.current.timestamp
        : 900;
      const cameraMs = Math.max(0, Math.min(1000, gap * 0.95));
      lastFixRef.current = fix;
      const result = matchFix(fix, path, c, m, trackerRef.current);
      trackerRef.current = result.state;
      setMatch(result);
      setAccuracy(fix.accuracy);
      setFixTime(fix.timestamp);
      // A good fix clears any GPS complaint ("waiting", "could not
      // determine a position" after a tunnel) - but not routing messages.
      setStatus((s) => (s !== null && GPS_MESSAGES.has(s) ? null : s));

      const map = mapRef.current;
      if (map) {
        // Draw the rider where the GPS says when off the line, snapped when on it.
        const onRoute = result.distanceFromRoute < 35;
        const at = onRoute ? result.snapped : { lat: fix.lat, lng: fix.lng };
        const bearing = onRoute
          ? result.routeBearing
          : (fix.heading ?? result.routeBearing);
        (map.getSource("tour-position") as GeoJSONSource | undefined)?.setData({
          type: "Feature",
          geometry: { type: "Point", coordinates: [at.lng, at.lat] },
          properties: { bearing },
        });
        if (!result.state.offRoute) {
          (map.getSource("route") as GeoJSONSource | undefined)?.setData({
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: pathFrom(path, c, result.state.furthestMeters).map(
                (p) => [p.lng, p.lat],
              ),
            },
            properties: {},
          });
        }
        if (followRef.current) {
          map.easeTo({
            center: [at.lng, at.lat],
            bearing,
            pitch: NAV_PITCH,
            zoom: NAV_ZOOM,
            // Rider in the lower third, like any navigation app: the road
            // ahead matters, the road behind does not.
            offset: [0, map.getContainer().clientHeight * 0.22],
            duration: cameraMs,
            easing: (t) => t,
          });
        }
      }

      if (result.state.offRoute && !result.state.arrived) void reroute(fix);
    },
    [reroute],
  );

  // --- map ---------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || initialRoute.path.length < 2) return;
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
    const start = initialRoute.path[0];
    const map = new MlMap({
      container: containerRef.current,
      style: satelliteStyle(),
      center: [start.lng, start.lat],
      zoom: NAV_ZOOM,
      pitch: NAV_PITCH,
      attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true },
      maxPitch: 75,
    });
    mapRef.current = map;
    map.on("load", () => {
      // MapLibre opens the compact attribution expanded on wide screens,
      // where it sits under the trip card. Start it collapsed; the (i)
      // button still shows the full credits.
      map
        .getContainer()
        .querySelector(".maplibregl-ctrl-attrib")
        ?.classList.remove("maplibregl-compact-show");
      if (!map.hasImage("cyclist")) {
        const img = makeCyclistIcon();
        if (img) map.addImage("cyclist", img, { pixelRatio: 2 });
      }
      addTourLayers(map, {
        path: initialRoute.path,
        profile: initialRoute.profile,
        pathElevations: initialRoute.pathElevations,
        includeTraffic: false,
      });
    });
    // Panning by hand stops the camera following until "Re-centre".
    map.on("dragstart", () => {
      followRef.current = false;
      setFollowing(false);
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [initialRoute]);

  // --- position source ---------------------------------------------------
  useEffect(() => {
    if (source !== "gps") return;
    if (typeof window !== "undefined" && !window.isSecureContext) {
      // Deferred so the message is set from a callback, not synchronously in the effect.
      const t = setTimeout(
        () =>
          setError(
            "Live GPS needs a secure page. Open this site over https (or on localhost) - a phone on http://192.168.x.x is blocked by the browser.",
          ),
        0,
      );
      return () => clearTimeout(t);
    }
    if (!("geolocation" in navigator)) {
      const t = setTimeout(
        () => setError("This browser has no location support."),
        0,
      );
      return () => clearTimeout(t);
    }
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        handleFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: Number.isFinite(pos.coords.heading)
            ? pos.coords.heading
            : null,
          speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          timestamp: pos.timestamp,
        }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setError(geoErrorMessage(err));
        else setStatus(geoErrorMessage(err));
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [source, handleFix]);

  useEffect(() => {
    if (source !== "simulate" || paused) return;
    const id = setInterval(() => {
      const { path, cum: c } = routeRef.current;
      simMetersRef.current = Math.min(
        c[c.length - 1],
        simMetersRef.current + CRUISE_SPEED_MPS * simSpeed,
      );
      // "Go off route" ramps the rider sideways until the tracker gives up
      // on the line, then the reroute lands them on a fresh one at 0m.
      if (driftRef.current > 0) driftRef.current += 25;
      handleFix(
        simulatedFix(path, c, simMetersRef.current, {
          lateralMeters: driftRef.current,
          speed: CRUISE_SPEED_MPS * simSpeed,
        }),
      );
    }, SIM_TICK_MS);
    return () => clearInterval(id);
  }, [source, paused, simSpeed, handleFix]);

  // Keep the screen on while navigating - a phone that sleeps mid-ride
  // also stops delivering GPS to the page.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (t: "screen") => Promise<{ release: () => Promise<void> }>;
      };
    };
    nav.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      void lock?.release().catch(() => {});
    };
  }, []);

  function recenter() {
    followRef.current = true;
    setFollowing(true);
  }

  // Before the first fix, preview the first turn; after that, trust the
  // tracker even when it says null (past the last turn) - falling back to
  // maneuvers[1] there put the very first instruction back up on arrival.
  const next: Maneuver | null = match ? match.next : (maneuvers[1] ?? null);
  const toNext = match ? match.metersToNext : (next?.atMeters ?? 0);
  const remaining = match ? match.metersRemaining : cum[cum.length - 1];
  // "Then ..." preview when two maneuvers come in quick succession.
  const after = next ? maneuvers[maneuvers.indexOf(next) + 1] : undefined;
  const showThen = after && next && after.atMeters - next.atMeters < 150;
  const arrived = match?.state.arrived ?? false;
  const offRoute = match?.state.offRoute ?? false;
  const arrivalClock =
    fixTime === null
      ? null
      : new Date(
          fixTime + (remaining / CRUISE_SPEED_MPS) * 1000,
        ).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });

  return (
    <div
      className="absolute inset-0 z-30 bg-slate-900"
      data-testid="navigation-view"
    >
      {/* h-full w-full, not absolute inset-0: maplibre-gl.css sets .maplibregl-map to position: relative, which cancels the inset and leaves a 0px-tall map. */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Next maneuver */}
      <div className="absolute inset-x-3 top-3 flex flex-col gap-1">
        {!arrived && (rerouting || offRoute || next) && (
          <div
            className={`flex items-center gap-3 rounded-xl px-4 py-3 text-white shadow-lg ${offRoute || rerouting ? "bg-amber-600" : "bg-emerald-700"}`}
            role="status"
            aria-live="polite"
          >
            {rerouting || offRoute ? (
              <p className="text-lg font-semibold">
                {rerouting ? "Finding a new route…" : "Off route"}
              </p>
            ) : next ? (
              <>
                <TurnArrow type={next.type} />
                <div className="min-w-0">
                  <p
                    className="text-2xl font-bold leading-tight"
                    data-testid="nav-distance"
                  >
                    {next.type === "arrive" && toNext < 30
                      ? "Arriving"
                      : formatDistance(toNext)}
                  </p>
                  <p
                    className="truncate text-base font-medium"
                    data-testid="nav-instruction"
                  >
                    {next.text}
                  </p>
                </div>
              </>
            ) : null}
          </div>
        )}
        {showThen && !offRoute && !rerouting && (
          <div className="flex w-fit items-center gap-2 rounded-lg bg-emerald-900/90 px-3 py-1.5 text-sm text-white">
            <span>Then</span>
            <span className="h-5 w-5 [&>svg]:h-5 [&>svg]:w-5">
              <TurnArrow type={after.type} />
            </span>
            <span className="truncate">{after.street ?? after.text}</span>
          </div>
        )}
        {status && (
          <p className="w-fit rounded-md bg-black/70 px-3 py-1 text-xs text-white">
            {status}
          </p>
        )}
        {details && <RouteDetailsToggle description={details} />}
      </div>

      {!following && !arrived && (
        <button
          type="button"
          onClick={recenter}
          className="absolute bottom-36 right-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-lg"
        >
          Re-centre
        </button>
      )}

      {/* Trip summary + controls */}
      <div className="absolute inset-x-3 bottom-8 flex flex-col gap-2 rounded-xl bg-white/95 p-3 text-slate-900 shadow-lg">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xl font-bold" data-testid="nav-eta">
              {formatEta(remaining)}
            </p>
            <p className="text-xs text-slate-600">
              {formatDistance(remaining)}
              {arrivalClock && ` · arrive ${arrivalClock}`}
              {rerouteCount > 0 && ` · rerouted ${rerouteCount}×`}
              {source === "gps" &&
                accuracy !== null &&
                ` · GPS ±${Math.round(accuracy)} m`}
            </p>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white"
          >
            End
          </button>
        </div>
        {source === "simulate" && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2 text-xs">
            <span className="font-semibold text-slate-500">Simulated ride</span>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="rounded border border-slate-300 px-2 py-1"
            >
              {paused ? "Resume" : "Pause"}
            </button>
            {[1, 4, 10].map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setSimSpeed(x)}
                aria-pressed={simSpeed === x}
                className={`rounded border px-2 py-1 ${simSpeed === x ? "border-emerald-600 bg-emerald-50 font-semibold" : "border-slate-300"}`}
              >
                {x}×
              </button>
            ))}
            <button
              type="button"
              onClick={() => (driftRef.current = 1)}
              disabled={offRoute || rerouting}
              className="rounded border border-amber-500 px-2 py-1 text-amber-700 disabled:opacity-50"
            >
              Go off route
            </button>
          </div>
        )}
      </div>

      {arrived && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="rounded-2xl bg-white p-6 text-center shadow-xl">
            <p className="text-2xl font-bold text-slate-900">
              You have arrived
            </p>
            <button
              type="button"
              onClick={onExit}
              className="mt-4 rounded-lg bg-emerald-700 px-5 py-2 font-semibold text-white"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-6">
          <div className="max-w-sm rounded-2xl bg-white p-5 text-slate-900 shadow-xl">
            <p className="font-semibold">Can&apos;t start live navigation</p>
            <p className="mt-2 text-sm">{error}</p>
            <button
              type="button"
              onClick={onExit}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
