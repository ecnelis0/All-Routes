"use client";

import { useJsApiLoader } from "@react-google-maps/api";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import AddressSearch from "@/components/AddressSearch";
import MapView from "@/components/MapView";
// Loaded lazily: maplibre-gl is ~900KB and only needed when a tour opens.
const Route3DTour = dynamic(() => import("@/components/Route3DTour"), { ssr: false });
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
  neighborhoodRiskLabel,
} from "@/lib/data/sfDangerousNeighborhoods";
import { DEMO_CITY } from "@/lib/mockData";
import type { RouteSummary } from "@/lib/routing/service";
import type {
  BikeLaneSegment,
  DangerZone,
  HighwaySegment,
  LatLng,
  NamedDangerLocation,
} from "@/lib/types";

type RouteProfileId = RouteSummary["profile"];

// No "places" library: address search goes through /api/geocode (see
// components/AddressSearch.tsx) because this Cloud project has only the
// Maps JavaScript API enabled.
const LIBRARIES: [] = [];

interface LayersResponse {
  city: { name: string; center: { lat: number; lng: number } };
  dangerZones: DangerZone[];
  highways: HighwaySegment[];
  bikeLanes: BikeLaneSegment[];
  namedDangerLocations: NamedDangerLocation[];
}

// The 3 route choices, in the order they're revealed: Google's own route
// resolves first (near-instant), then the two safety tiers stream in after.
const ROUTE_TABS: { kind: RouteProfileId; label: string }[] = [
  { kind: "fastest", label: "Fastest" },
  { kind: "balanced", label: "Safer" },
  { kind: "safest", label: "Safest" },
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
  const [selectedRouteKind, setSelectedRouteKind] = useState<RouteProfileId>("fastest");
  const [originText, setOriginText] = useState("");
  const [destinationText, setDestinationText] = useState("");
  const [modelMeta, setModelMeta] = useState<{ modelSource: string; modelVersion: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
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
  async function startRouteSearch(from: LatLng, to: LatLng) {
    const requestId = ++routeRequestIdRef.current;
    setRoutes({});
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
        body: JSON.stringify({ origin: from, destination: to }),
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

  function selectRouteTab(kind: RouteProfileId) {
    if (!routes[kind]) return;
    setSelectedRouteKind(kind);
    setConfirmed(false);
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

  const activeRoute = routes[selectedRouteKind] ?? null;
  const hasBothEnds = Boolean(origin && destination);

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-80 flex-shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-4">
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
              {ROUTE_TABS.map((tab) => {
                const route = routes[tab.kind];
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
                    <span className="font-medium">{tab.label}</span>
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

            {activeRoute && (
              <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-black">
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

            <button
              type="button"
              onClick={() => setTourOpen(true)}
              disabled={!activeRoute || activeRoute.path.length < 2}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-black hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              View 3D tour
            </button>
            <button
              type="button"
              onClick={() => setConfirmed(true)}
              disabled={!activeRoute}
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
            {/*
              Street-by-street rather than turn-by-turn. Real turn
              instructions ("turn left onto Valencia") need bearing changes
              computed at each node plus street-name transitions; the old
              version got them free from Google's Directions API, which this
              project can no longer call. Listing the streets in order is
              honest about what we actually know and still orients a rider.
            */}
            <ol className="flex flex-col gap-1.5 text-xs text-black">
              {activeRoute.streets.map((street, i) => (
                <li key={`${street}-${i}`} className="flex gap-2 border-b border-slate-100 pb-1.5 last:border-0">
                  <span className="font-semibold text-black">{i + 1}.</span>
                  <span>{street}</span>
                </li>
              ))}
            </ol>
            {activeRoute.streets.length === 0 && (
              <p className="text-xs text-black/60">
                This route runs mostly on unnamed paths and connectors.
              </p>
            )}
          </section>
        )}
      </aside>

      {/* relative so the 3D tour overlay can position against the map area */}
      <main className="relative flex-1">
        <MapView
          center={data?.city.center ?? { lat: 37.7749, lng: -122.4194 }}
          isLoaded={isLoaded}
          origin={origin}
          destination={destination}
          selectedRoute={activeRoute ? { kind: selectedRouteKind, path: activeRoute.path } : null}
          dangerZones={showNeighborhoodView ? (data?.dangerZones ?? []) : []}
          dangerousNeighborhoods={showNeighborhoodView ? SF_DANGEROUS_NEIGHBORHOODS : []}
        />
        {tourOpen && activeRoute && (
          <Route3DTour
            path={activeRoute.path}
            profile={activeRoute.profile}
            streetSpans={activeRoute.streetSpans}
            protectedSpans={activeRoute.protectedSpans}
            avoidedNearby={activeRoute.avoidedNearby}
            onClose={() => setTourOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
