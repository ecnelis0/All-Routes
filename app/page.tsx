"use client";

import { useJsApiLoader } from "@react-google-maps/api";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import AddressSearch from "@/components/AddressSearch";
import MapView, { type MapRoute, type MapRouteKind, type RoutePopup } from "@/components/MapView";
// Loaded lazily: maplibre-gl is ~900KB and only needed when a tour opens.
const Route3DTour = dynamic(() => import("@/components/Route3DTour"), { ssr: false });
const NavigationView = dynamic(() => import("@/components/NavigationView"), { ssr: false });
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
  neighborhoodRiskLabel,
} from "@/lib/data/sfDangerousNeighborhoods";
import { DEMO_CITY } from "@/lib/mockData";
import { buildManeuvers, formatDistance } from "@/lib/nav/instructions";
import { describeRoute } from "@/lib/ui/routeDescription";
import { insertWaypoint } from "@/lib/ui/geometry";
import { RouteChoiceList } from "@/components/RouteChoices";
import type { RouteSummary } from "@/lib/routing/service";
import type {
  BikeLaneSegment,
  DangerZone,
  LatLng,
  NamedDangerLocation,
} from "@/lib/types";

type RouteProfileId = RouteSummary["profile"];
/** A standard option, or the rider's own edited route. */
type RouteKey = MapRouteKind;
const MAX_STOPS = 8;

// No "places" library: address search goes through /api/geocode (see
// components/AddressSearch.tsx) because this Cloud project has only the
// Maps JavaScript API enabled.
const LIBRARIES: [] = [];

interface LayersResponse {
  city: { name: string; center: { lat: number; lng: number } };
  dangerZones: DangerZone[];
  bikeLanes: BikeLaneSegment[];
  namedDangerLocations: NamedDangerLocation[];
}

// The 3 route choices, in the order they're revealed: Google's own route
// resolves first (near-instant), then the two safety tiers stream in after.
// Labels mirror ROUTE_PROFILES in lib/routing/cost.ts. The route itself
// carries its label too (with "best effort" appended when hard avoidance
// had to be relaxed), and that takes precedence when shown.
const ROUTE_TABS: { kind: RouteProfileId; label: string; hint: string }[] = [
  { kind: "fastest", label: "Fastest", hint: "Shortest legal bike route" },
  { kind: "balanced", label: "Safest", hint: "Avoids every flagged area" },
  { kind: "safest", label: "Safest + bike lanes", hint: "Also keeps to protected lanes" },
];

function metersToMiles(m: number): string {
  return (m / 1609.34).toFixed(1);
}

function secondsToMinutes(s: number): string {
  return Math.round(s / 60).toString();
}

/**
 * Minutes at a steady 13 km/h city-cycling average.
 *
 * The old number came from Google's Directions API, which modelled grades
 * and signals. Routing on our own graph means we no longer get that for
 * free, and a flat average over San Francisco's hills is genuinely rough -
 * it is labelled as an estimate in the UI rather than presented as a
 * prediction.
 */
const CYCLING_METERS_PER_SECOND = 3.6;

function estimateMinutes(meters: number): string {
  return Math.max(1, Math.round(meters / CYCLING_METERS_PER_SECOND / 60)).toString();
}

/** e.g. "+4 min" / "-2 min" / "same time" relative to the fastest route. */
function timeDiffLabel(current: RouteSummary, baseline: RouteSummary): string {
  const diffMin = Math.round(
    (current.distanceMeters - baseline.distanceMeters) / CYCLING_METERS_PER_SECOND / 60
  );
  if (diffMin === 0) return "same time";
  return diffMin > 0 ? `+${diffMin} min` : `${diffMin} min`;
}

function percentLessDanger(fastest: RouteSummary, other: RouteSummary): number {
  if (fastest.meanDanger <= 0) return 0;
  return Math.round(((fastest.meanDanger - other.meanDanger) / fastest.meanDanger) * 1000) / 10;
}

export default function Home() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const { isLoaded, loadError } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: apiKey ?? "",
    libraries: LIBRARIES,
  });

  const [data, setDataState] = useState<LayersResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const layersPromiseRef = useRef<Promise<LayersResponse> | null>(null);
  // Off by default so the app still opens on a stock, uncluttered map -
  // "neighborhood view" is an opt-in layer showing every currently-known
  // danger zone (the same ones routes are automatically detoured around),
  // not just whichever ones happen to sit on the chosen route.
  const [showNeighborhoodView, setShowNeighborhoodView] = useState(false);

  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [routes, setRoutes] = useState<Record<string, RouteSummary>>({});
  const [selectedRouteKind, setSelectedRouteKind] = useState<RouteKey>("fastest");
  const [originText, setOriginText] = useState("");
  const [destinationText, setDestinationText] = useState("");
  const [modelMeta, setModelMeta] = useState<{ modelSource: string; modelVersion: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [avoidElevation, setAvoidElevation] = useState(false);
  const [fewerSignals, setFewerSignals] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [navSource, setNavSource] = useState<"gps" | "simulate" | null>(null);
  /** Routes the rider took off the map. Reset by every new search. */
  const [hiddenRoutes, setHiddenRoutes] = useState<RouteKey[]>([]);
  const [routePopup, setRoutePopup] = useState<RoutePopup | null>(null);
  /**
   * A route has been SELECTED: only it is on the map, and it can be
   * toured, navigated or edited. "Show all routes" goes back.
   */
  const [focused, setFocused] = useState(false);
  /** The rider's saved, edited route ("My route"). */
  const [customRoute, setCustomRoute] = useState<RouteSummary | null>(null);
  // Edit mode. The route being edited is planned with `editProfile`'s
  // rules through `editStops`; `draftRoute` is the latest result and
  // `editOriginal` the route as it was, for comparison.
  const [editing, setEditing] = useState(false);
  const [editProfile, setEditProfile] = useState<RouteProfileId>("fastest");
  const [editOriginal, setEditOriginal] = useState<RouteSummary | null>(null);
  const [editStops, setEditStops] = useState<LatLng[]>([]);
  const [draftRoute, setDraftRoute] = useState<RouteSummary | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const draftRequestIdRef = useRef(0);
  const [computingSafer, setComputingSafer] = useState(false);
  const [routingError, setRoutingError] = useState<string | null>(null);

  // Bumped on every route search kicked off, so a slow, older search can
  // never overwrite state with a stale result after a newer one (e.g. the
  // user changes the destination again before the first lookup finishes).
  const routeRequestIdRef = useRef(0);

  // Warmed up on mount (in the background - the initial "stock" screen just
  // shows the two address inputs regardless) and cached in a ref so every
  // caller shares the one in-flight/resolved request instead of firing a
  // fresh fetch each time a route search starts.
  function ensureLayersLoaded(): Promise<LayersResponse> {
    if (!layersPromiseRef.current) {
      layersPromiseRef.current = fetch("/api/layers")
        .then((res) => {
          if (!res.ok) throw new Error(`Request failed: ${res.status}`);
          return res.json() as Promise<LayersResponse>;
        })
        .then((json) => {
          setDataState(json);
          return json;
        })
        .catch((err) => {
          layersPromiseRef.current = null; // allow a later retry
          setFetchError(err instanceof Error ? err.message : "Failed to load map data");
          throw err;
        });
    }
    return layersPromiseRef.current;
  }

  useEffect(() => {
    ensureLayersLoaded().catch(() => {
      /* surfaced via fetchError state above */
    });
  }, []);

  function resetRouteState() {
    routeRequestIdRef.current++; // invalidate any in-flight search
    setTourOpen(false);
    setRoutes({});
    setSelectedRouteKind("fastest");
    setConfirmed(false);
    setHiddenRoutes([]);
    setRoutePopup(null);
    setFocused(false);
    setCustomRoute(null);
    exitEditing();
    setComputingSafer(false);
    setRoutingError(null);
  }

  /**
   * Asks our own routing service for all three profiles.
   *
   * Replaces the old browser-side Google Directions call plus waypoint
   * nudging. The graph is ~210k edges and lives on the server, so the
   * client sends two points and receives three finished routes - see
   * app/api/route/route.ts.
   */
  async function startRouteSearch(
    from: LatLng,
    to: LatLng,
    hills = avoidElevation,
    lights = fewerSignals
  ) {
    const requestId = ++routeRequestIdRef.current;
    setRoutes({});
    setHiddenRoutes([]);
    setRoutePopup(null);
    setFocused(false);
    setCustomRoute(null);
    exitEditing();
    setSelectedRouteKind("fastest");
    setConfirmed(false);
    setRoutingError(null);
    setComputingSafer(true);

    try {
      void ensureLayersLoaded().catch(() => {
        /* map layers are independent of routing; surfaced via fetchError */
      });

      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: from,
          destination: to,
          avoidElevation: hills,
          fewerSignals: lights,
        }),
      });
      const json = (await res.json()) as {
        routes?: RouteSummary[];
        meta?: { modelSource: string; modelVersion: string };
        error?: string;
      };
      if (requestId !== routeRequestIdRef.current) return; // a newer search won

      if (!res.ok) {
        setRoutingError(json.error ?? `Routing failed (${res.status}).`);
        return;
      }
      const byProfile: Record<string, RouteSummary> = {};
      for (const r of json.routes ?? []) byProfile[r.profile] = r;
      setRoutes(byProfile);
      setModelMeta(json.meta ?? null);
    } catch (err) {
      if (requestId !== routeRequestIdRef.current) return;
      setRoutingError(err instanceof Error ? err.message : "Failed to compute a route");
    } finally {
      if (requestId === routeRequestIdRef.current) setComputingSafer(false);
    }
  }

  // Every place origin/destination can change - a fresh Autocomplete pick,
  // or the input being edited away from its last valid pick (see
  // `handleAddressInputChange` below) - drops any previously-drawn route
  // immediately, then kicks off a brand new search the moment *both* ends
  // are known (no separate "find route" button - the whole point is that
  // Google's route just appears as soon as you've entered A and B).
  function updateOrigin(value: LatLng | null) {
    setOrigin(value);
    resetRouteState();
    if (value && destination) void startRouteSearch(value, destination);
  }

  function updateDestination(value: LatLng | null) {
    setDestination(value);
    resetRouteState();
    if (origin && value) void startRouteSearch(origin, value);
  }

  function toggleAvoidElevation() {
    const next = !avoidElevation;
    setAvoidElevation(next);
    // Pass the new value explicitly: state set above is not visible until
    // the next render, so reading it inside startRouteSearch would re-plan
    // with the OLD setting.
    if (origin && destination) {
      resetRouteState();
      void startRouteSearch(origin, destination, next, fewerSignals);
    }
  }

  function toggleFewerSignals() {
    const next = !fewerSignals;
    setFewerSignals(next);
    if (origin && destination) {
      resetRouteState();
      void startRouteSearch(origin, destination, avoidElevation, next);
    }
  }

  function routeFor(kind: RouteKey): RouteSummary | null {
    return kind === "custom" ? customRoute : (routes[kind] ?? null);
  }

  function selectRouteTab(kind: RouteKey) {
    if (!routeFor(kind)) return;
    if (editing) exitEditing();
    setSelectedRouteKind(kind);
    setConfirmed(false);
    // Choosing a route you removed puts it back - you asked to see it.
    setHiddenRoutes((h) => h.filter((k) => k !== kind));
  }

  /** Select a route: only it stays on the map, ready to tour, navigate or edit. */
  function selectRoute(kind: RouteKey) {
    selectRouteTab(kind);
    setFocused(true);
    setRoutePopup(null);
  }

  function exitSelection() {
    exitEditing();
    setFocused(false);
    setRoutePopup(null);
  }

  function removeRouteFromMap(kind: RouteKey) {
    setHiddenRoutes((h) => (h.includes(kind) ? h : [...h, kind]));
    setRoutePopup(null);
  }

  // --- route editing ------------------------------------------------------
  function exitEditing() {
    draftRequestIdRef.current++; // drop any in-flight re-plan
    setEditing(false);
    setEditStops([]);
    setDraftRoute(null);
    setEditOriginal(null);
    setDraftError(null);
    setDraftBusy(false);
  }

  function startEditing() {
    const base = routeFor(selectedRouteKind);
    if (!base) return;
    setEditProfile(base.profile);
    setEditOriginal(base);
    // Editing "My route" again continues from its stops.
    setEditStops(base.customWaypoints ?? []);
    setDraftRoute(base.customWaypoints ? base : null);
    setDraftError(null);
    setEditing(true);
    setFocused(true);
    setTourOpen(false);
    setConfirmed(false);
    setNavSource(null);
    setRoutePopup(null);
  }

  async function replanDraft(stops: LatLng[]) {
    if (!origin || !destination) return;
    const id = ++draftRequestIdRef.current;
    setDraftBusy(true);
    setDraftError(null);
    try {
      const res = await fetch("/api/route/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          destination,
          waypoints: stops,
          profile: editProfile,
          avoidElevation,
          fewerSignals,
        }),
      });
      const json = (await res.json()) as { route?: RouteSummary; error?: string };
      if (id !== draftRequestIdRef.current) return; // a newer edit won
      if (!res.ok || !json.route) setDraftError(json.error ?? `Could not plan that route (${res.status}).`);
      else setDraftRoute(json.route);
    } catch (err) {
      if (id === draftRequestIdRef.current) setDraftError(err instanceof Error ? err.message : "Could not plan that route.");
    } finally {
      if (id === draftRequestIdRef.current) setDraftBusy(false);
    }
  }

  function updateStops(next: LatLng[]) {
    setEditStops(next);
    void replanDraft(next);
  }

  function addStop(at: LatLng) {
    if (editStops.length >= MAX_STOPS) {
      setDraftError(`A route can have at most ${MAX_STOPS} stops - remove one first.`);
      return;
    }
    const current = (draftRoute ?? editOriginal)?.path ?? [];
    updateStops(insertWaypoint(editStops, at, current));
  }

  function moveStop(index: number, to: LatLng) {
    updateStops(editStops.map((w, i) => (i === index ? to : w)));
  }

  function removeStop(index: number) {
    updateStops(editStops.filter((_, i) => i !== index));
  }

  function saveEdit() {
    if (!draftRoute) return;
    setCustomRoute(draftRoute);
    setSelectedRouteKind("custom");
    setHiddenRoutes((h) => h.filter((k) => k !== "custom"));
    exitEditing();
    setFocused(true);
  }

  if (!apiKey) {
    return (
      <div className="flex flex-1 items-center justify-center bg-slate-100 p-8 text-center text-slate-600">
        <p className="max-w-md">
          Missing <code className="rounded bg-slate-200 px-1">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code>.
          Add it to <code className="rounded bg-slate-200 px-1">.env.local</code> and restart the dev
          server.
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center bg-red-50 p-8 text-center text-red-700">
        Failed to load Google Maps: {loadError.message}
      </div>
    );
  }

  const describe = (route: RouteSummary) => describeRoute(route, estimateMinutes(route.distanceMeters));
  const selectedRoute = routeFor(selectedRouteKind);
  // While editing, the route on screen (and in the sidebar) is the edited
  // draft - or the original until the first stop is added.
  const activeRoute = editing ? (draftRoute ?? editOriginal) : selectedRoute;
  const tabs: { kind: RouteKey; label: string; hint: string }[] = [
    ...ROUTE_TABS,
    ...(customRoute ? [{ kind: "custom" as const, label: "My route", hint: "Your edited route" }] : []),
  ];
  const mapRoutes: MapRoute[] = editing
    ? activeRoute
      ? [{ kind: "custom", path: activeRoute.path, description: describe(activeRoute) }]
      : []
    : focused
      ? selectedRoute
        ? [{ kind: selectedRouteKind, path: selectedRoute.path, description: describe(selectedRoute) }]
        : []
      : tabs.flatMap((tab) => {
          const route = routeFor(tab.kind);
          if (!route || hiddenRoutes.includes(tab.kind)) return [];
          return [{ kind: tab.kind, path: route.path, description: describe(route) }];
        });
  const hasBothEnds = Boolean(origin && destination);

  return (
    // min-h-0 on every flex child in this chain. Flex items default to
    // min-height:auto, which means they refuse to shrink below their
    // content - so `overflow-y-auto` on the sidebar never engaged and a
    // long route panel stretched the whole row instead of scrolling.
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="flex min-h-0 w-80 flex-shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-4">
        <div>
          <h1 className="text-lg font-bold text-black">🚲 Safe Route</h1>
          <p className="mt-1 text-xs text-black">San Francisco, CA</p>
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-black">
            Plan a route
          </h2>
          <AddressSearch
            placeholder="Start address (A)"
            value={originText}
            onValueChange={setOriginText}
            onSelect={(point) => updateOrigin(point)}
          />
          <AddressSearch
            placeholder="Destination address (B)"
            value={destinationText}
            onValueChange={setDestinationText}
            onSelect={(point) => updateDestination(point)}
          />
          {fetchError && <p className="text-xs text-black">{fetchError}</p>}
          {routingError && <p className="text-xs text-black">{routingError}</p>}
        </section>

        <section className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={toggleAvoidElevation}
            aria-pressed={avoidElevation}
            className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
              avoidElevation
                ? "border-emerald-600 bg-emerald-50 text-black"
                : "border-slate-200 bg-white text-black hover:bg-slate-50"
            }`}
          >
            <span className="font-medium">Avoid hills</span>
            <span className="text-[11px] text-black">{avoidElevation ? "On" : "Off"}</span>
          </button>
          <button
            type="button"
            onClick={toggleFewerSignals}
            aria-pressed={fewerSignals}
            className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
              fewerSignals
                ? "border-sky-600 bg-sky-50 text-black"
                : "border-slate-200 bg-white text-black hover:bg-slate-50"
            }`}
          >
            <span className="flex flex-col">
              <span className="font-medium">Fewer traffic lights</span>
              <span className="text-[10px] text-black/55">Smoother, fewer stops</span>
            </span>
            <span className="text-[11px] text-black">{fewerSignals ? "On" : "Off"}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowNeighborhoodView((v) => !v)}
            className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
              showNeighborhoodView
                ? "border-red-600 bg-red-50 text-black"
                : "border-slate-200 bg-white text-black hover:bg-slate-50"
            }`}
          >
            <span className="font-medium">Neighborhood view</span>
            <span className="text-[11px] text-black">
              {showNeighborhoodView ? "Hide" : "Show dangerous areas"}
            </span>
          </button>
          {showNeighborhoodView && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] leading-snug text-black">
                Shaded circles are flagged neighbourhoods; small circles are crash hotspots.
                Routing actively avoids both - the safer profiles treat area risk as a cost,
                not a suggestion.
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {[85, 70, 55].map((risk) => (
                  <span key={risk} className="flex items-center gap-1 text-[11px] text-black">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        background: neighborhoodRiskColor(risk),
                        opacity: 0.55,
                        border: `1px solid ${neighborhoodRiskColor(risk)}`,
                      }}
                    />
                    {neighborhoodRiskLabel(risk)}
                  </span>
                ))}
              </div>
              <details className="text-[11px] text-black">
                <summary className="cursor-pointer select-none">
                  {SF_DANGEROUS_NEIGHBORHOODS.length} flagged areas
                </summary>
                <ul className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
                  {SF_DANGEROUS_NEIGHBORHOODS.map((a) => (
                    <li key={a.id} className="flex items-center gap-1">
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: neighborhoodRiskColor(a.risk) }}
                      />
                      <span className="truncate">{a.name}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </section>

        {hasBothEnds && !routingError && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-black">
              Choose a route
            </h2>
            <div className="grid grid-cols-1 gap-1.5">
              {tabs.map((tab) => {
                const route = routeFor(tab.kind);
                const isSelected = selectedRouteKind === tab.kind;
                const isReady = Boolean(route);
                return (
                  <button
                    key={tab.kind}
                    type="button"
                    onClick={() => selectRouteTab(tab.kind)}
                    disabled={!isReady}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      isSelected
                        ? "border-blue-600 bg-blue-50 text-black"
                        : "border-slate-200 bg-white text-black hover:bg-slate-50"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span className="flex flex-col">
                      <span className="font-medium">{route?.label ?? tab.label}</span>
                      <span className="text-[10px] text-black/55">
                        {route && hiddenRoutes.includes(tab.kind) ? "Removed from map \u00b7 click to show" : tab.hint}
                      </span>
                    </span>
                    <span className="text-[11px] text-black">
                      {route
                        ? `${metersToMiles(route.distanceMeters)} mi \u00b7 ~${estimateMinutes(route.distanceMeters)} min`
                        : computingSafer
                          ? "Computing\u2026"
                          : "\u2014"}
                    </span>
                  </button>
                );
              })}
            </div>
            {hiddenRoutes.length > 0 && (
              <button
                type="button"
                onClick={() => setHiddenRoutes([])}
                className="self-start text-xs font-medium text-blue-700 hover:underline"
              >
                Show {hiddenRoutes.length === 1 ? "removed route" : `all ${hiddenRoutes.length} removed routes`} on map
              </button>
            )}
            {!focused && (
              <p className="text-[10px] text-black/50">
                Tip: click any route on the map to see what kind it is, then select it to tour,
                navigate or edit it.
              </p>
            )}

            {focused && !editing && selectedRoute && (
              <div className="flex flex-col gap-2 rounded-lg border-2 border-blue-600 bg-blue-50 p-2.5 text-xs text-black" data-testid="selected-route">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-800">Selected route</p>
                  <p className="text-sm font-semibold">{selectedRoute.label}</p>
                  <p className="text-[11px] text-black/60">Only this route is on the map.</p>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={startEditing}
                    className="flex-1 rounded-md bg-violet-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
                  >
                    Edit route
                  </button>
                  <button
                    type="button"
                    onClick={exitSelection}
                    className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
                  >
                    Show all routes
                  </button>
                </div>
              </div>
            )}

            {editing && editOriginal && (
              <div className="flex flex-col gap-2 rounded-lg border-2 border-violet-600 bg-violet-50 p-2.5 text-xs text-black" data-testid="edit-panel">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-800">Editing route</p>
                  <p className="text-sm font-semibold">Based on {editOriginal.label}</p>
                  <p className="mt-0.5 leading-snug text-black/70">
                    Click the map (or the route) to add a stop it must pass through. Drag a stop to
                    move it; click a stop to remove it. Between stops it still follows{" "}
                    {editOriginal.label.replace(/ · best effort$/, "")}&apos;s rules.
                  </p>
                </div>

                {editStops.length > 0 && (
                  <ol className="flex flex-col gap-1">
                    {editStops.map((w, i) => (
                      <li key={`${i}-${w.lat}-${w.lng}`} className="flex items-center justify-between gap-2">
                        <span>
                          <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-violet-700 text-[10px] font-bold text-white">
                            {i + 1}
                          </span>
                          Stop {i + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeStop(i)}
                          aria-label={`Remove stop ${i + 1}`}
                          className="text-[11px] font-medium text-violet-800 hover:underline"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ol>
                )}

                {draftBusy && <p className="text-black/60">Re-planning…</p>}
                {draftError && <p className="rounded bg-red-50 px-2 py-1 text-red-700">{draftError}</p>}

                {draftRoute && (
                  <table className="w-full text-[11px]" data-testid="edit-compare">
                    <thead>
                      <tr className="text-black/60">
                        <th className="text-left font-medium" />
                        <th className="text-right font-medium">Original</th>
                        <th className="text-right font-medium">Yours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["Distance", `${metersToMiles(editOriginal.distanceMeters)} mi`, `${metersToMiles(draftRoute.distanceMeters)} mi`],
                        ["Danger (avg)", String(editOriginal.meanDanger), String(draftRoute.meanDanger)],
                        ["Protected lanes", `${Math.round(editOriginal.protectedLaneFraction * 100)}%`, `${Math.round(draftRoute.protectedLaneFraction * 100)}%`],
                        ["Traffic lights", String(editOriginal.trafficSignals), String(draftRoute.trafficSignals)],
                        ["Climbing", `${Math.round(editOriginal.elevationGainMeters * 3.281)} ft`, `${Math.round(draftRoute.elevationGainMeters * 3.281)} ft`],
                        ["In flagged areas", `${metersToMiles(editOriginal.metersInFlaggedAreas)} mi`, `${metersToMiles(draftRoute.metersInFlaggedAreas)} mi`],
                      ].map(([k, a, b]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td className="text-right">{a}</td>
                          <td className="text-right font-semibold">{b}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={!draftRoute || draftBusy}
                    className="flex-1 rounded-md bg-violet-700 px-2 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save as my route
                  </button>
                  <button
                    type="button"
                    onClick={() => updateStops([])}
                    disabled={editStops.length === 0}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    Clear stops
                  </button>
                  <button
                    type="button"
                    onClick={exitEditing}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {activeRoute && (
              <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-black">
                <div className="mb-1 border-b border-slate-200 pb-1.5" data-testid="route-details-choices">
                  <span className="font-semibold">{activeRoute.label}</span>
                  <RouteChoiceList description={describe(activeRoute)} />
                </div>
                <div className="flex justify-between">
                  <span>Distance</span>
                  <span className="font-medium">{metersToMiles(activeRoute.distanceMeters)} mi</span>
                </div>
                <div className="flex justify-between">
                  <span>Est. time</span>
                  <span className="font-medium">~{estimateMinutes(activeRoute.distanceMeters)} min</span>
                </div>
                {selectedRouteKind !== "fastest" && routes.fastest && (
                  <div className="flex justify-between">
                    <span>vs fastest route</span>
                    <span className="font-medium">{timeDiffLabel(activeRoute, routes.fastest)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Danger score (avg)</span>
                  <span className="font-medium">{activeRoute.meanDanger}</span>
                </div>
                <div className="flex justify-between">
                  <span>Worst street on route</span>
                  <span className="font-medium">{activeRoute.maxDanger}</span>
                </div>
                <div className="flex justify-between">
                  <span>On protected lanes</span>
                  <span className="font-medium">
                    {Math.round(activeRoute.protectedLaneFraction * 100)}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Traffic lights</span>
                  <span className="font-medium">{activeRoute.trafficSignals}</span>
                </div>
                <div className="flex justify-between">
                  <span>Elevation gain</span>
                  <span className="font-medium">
                    {Math.round(activeRoute.elevationGainMeters * 3.281)} ft
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Steepest climb</span>
                  <span
                    className={`font-medium ${activeRoute.maxGradePercent >= 12 ? "text-red-600" : ""}`}
                  >
                    {activeRoute.maxGradePercent}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Inside flagged areas</span>
                  <span className="font-medium">
                    {metersToMiles(activeRoute.metersInFlaggedAreas)} mi (
                    {Math.round(
                      (activeRoute.metersInFlaggedAreas / Math.max(1, activeRoute.distanceMeters)) *
                        100
                    )}
                    %)
                  </span>
                </div>

                {/best effort/i.test(activeRoute.label) && (
                  <p
                    role="note"
                    className="mt-1 rounded-md border border-slate-300 bg-slate-100 px-2 py-1.5 leading-snug text-slate-800"
                  >
                    Your start or destination is inside a flagged area, so this route
                    couldn&apos;t avoid every one. It avoids as much as the street network
                    allows.
                  </p>
                )}

                {activeRoute.detourWarning && (
                  <p
                    role="note"
                    className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 leading-snug text-amber-900"
                  >
                    {activeRoute.detourWarning.message}
                  </p>
                )}

                {activeRoute.steepClimbs.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5 border-t border-slate-200 pt-1.5">
                    <span className="font-semibold">Hard climbs on this route</span>
                    <ul className="list-disc pl-4">
                      {activeRoute.steepClimbs.slice(0, 4).map((c) => (
                        <li key={`${c.name}-${c.severity}`}>
                          {c.name}{" "}
                          <span className="text-black/60">
                            ({c.severity.toLowerCase()}, {Math.round(c.meters * 3.281)} ft)
                          </span>
                        </li>
                      ))}
                    </ul>
                    {!avoidElevation && (
                      <span className="text-[11px] text-black/60">
                        Turn on &ldquo;Avoid hills&rdquo; to route around these where possible.
                      </span>
                    )}
                  </div>
                )}

                {selectedRouteKind !== "fastest" && routes.fastest && (
                  <p className="mt-1 font-medium">
                    {percentLessDanger(routes.fastest, activeRoute) > 0
                      ? `${percentLessDanger(routes.fastest, activeRoute)}% less average danger than the fastest route.`
                      : "No safer than the fastest route here - it was already about as good as the network allows."}
                  </p>
                )}

                <div className="mt-1 flex flex-col gap-0.5 border-t border-slate-200 pt-1.5">
                  <span className="font-semibold">Flagged areas this route enters</span>
                  {activeRoute.neighborhoodsEntered.length > 0 ? (
                    <ul className="list-disc pl-4">
                      {activeRoute.neighborhoodsEntered.map((n) => (
                        <li key={n.name}>
                          {n.name}{" "}
                          <span className="text-black/60">({metersToMiles(n.meters)} mi)</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-black/60">None - this route stays clear of all of them.</span>
                  )}
                </div>

                {activeRoute.streets.length > 0 && (
                  <details className="mt-1 border-t border-slate-200 pt-1.5">
                    <summary className="cursor-pointer select-none font-semibold">
                      Streets ({activeRoute.streets.length})
                    </summary>
                    <p className="mt-1 leading-snug text-black/70">
                      {activeRoute.streets.join(" \u2192 ")}
                    </p>
                  </details>
                )}

                {modelMeta && (
                  <p className="mt-1 border-t border-slate-200 pt-1.5 text-[10px] text-black/50">
                    Scored by {modelMeta.modelSource} model{" "}
                    <code>{modelMeta.modelVersion}</code>
                  </p>
                )}
              </div>
            )}

            {!focused && activeRoute && (
              <button
                type="button"
                onClick={() => selectRoute(selectedRouteKind)}
                className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Select this route
              </button>
            )}
            <button
              type="button"
              // Toggles: the sidebar stays visible beside the tour, so the
              // same button that opened it is the natural way to close it.
              onClick={() => setTourOpen((open) => !open)}
              aria-pressed={tourOpen}
              disabled={editing || !activeRoute || activeRoute.path.length < 2}
              title={editing ? "Save or cancel your edit first" : undefined}
              className={`rounded-md border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                tourOpen
                  ? "border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                  : "border-slate-300 bg-white text-black hover:bg-slate-50"
              }`}
            >
              {tourOpen ? "Close 3D tour" : "View 3D tour"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmed(true)}
              disabled={editing || !activeRoute}
              title={editing ? "Save or cancel your edit first" : undefined}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Confirm route
            </button>
          </section>
        )}

        {confirmed && activeRoute && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-black">
              Route overview
            </h2>
            <ol className="flex flex-col gap-1.5 text-xs text-black" data-testid="turn-list">
              {buildManeuvers(activeRoute.path, activeRoute.streetSpans).map((m, i, all) => {
                const leg = (all[i + 1]?.atMeters ?? m.atMeters) - m.atMeters;
                return (
                  <li key={`${m.atMeters}-${i}`} className="flex justify-between gap-2 border-b border-slate-100 pb-1.5 last:border-0">
                    <span>{m.text}</span>
                    {leg > 0 && <span className="shrink-0 text-black/50">{formatDistance(leg)}</span>}
                  </li>
                );
              })}
            </ol>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNavSource("gps")}
                className="flex-1 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white"
              >
                Start navigation
              </button>
              <button
                type="button"
                onClick={() => setNavSource("simulate")}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-black hover:bg-slate-50"
              >
                Simulate ride
              </button>
            </div>
            {activeRoute.streets.length === 0 && (
              <p className="text-xs text-black/60">
                This route runs mostly on unnamed paths and connectors.
              </p>
            )}
          </section>
        )}
      </aside>

      {/* relative so the 3D tour overlay can position against the map area */}
      <main className="relative min-h-0 flex-1">
        <MapView
          center={data?.city.center ?? { lat: 37.7749, lng: -122.4194 }}
          isLoaded={isLoaded}
          origin={origin}
          destination={destination}
          routes={mapRoutes}
          selectedKind={activeRoute ? (editing ? "custom" : selectedRouteKind) : null}
          focused={focused || editing}
          popup={routePopup}
          onRouteClick={setRoutePopup}
          onPopupClose={() => setRoutePopup(null)}
          onSelectRoute={selectRoute}
          onExitSelection={exitSelection}
          onRemoveRoute={removeRouteFromMap}
          editing={editing}
          waypoints={editStops}
          ghostPath={editing && draftRoute ? (editOriginal?.path ?? null) : null}
          onAddStop={addStop}
          onMoveStop={moveStop}
          onRemoveStop={removeStop}
          dangerZones={showNeighborhoodView ? (data?.dangerZones ?? []) : []}
          dangerousNeighborhoods={showNeighborhoodView ? SF_DANGEROUS_NEIGHBORHOODS : []}
        />
        {tourOpen && activeRoute && (
          <Route3DTour
            path={activeRoute.path}
            profile={activeRoute.profile}
            streetSpans={activeRoute.streetSpans}
            classSpans={activeRoute.classSpans}
            pathElevations={activeRoute.pathElevations}
            protectedSpans={activeRoute.protectedSpans}
            avoidedNearby={activeRoute.avoidedNearby}
            details={describe(activeRoute)}
            onClose={() => setTourOpen(false)}
          />
        )}
        {navSource && activeRoute && destination && (
          <NavigationView
            route={activeRoute}
            destination={destination}
            source={navSource}
            avoidElevation={avoidElevation}
            fewerSignals={fewerSignals}
            details={describe(activeRoute)}
            waypoints={activeRoute.customWaypoints}
            onExit={() => setNavSource(null)}
          />
        )}
      </main>
    </div>
  );
}
