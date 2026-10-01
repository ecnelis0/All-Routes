"use client";

import { Autocomplete, useJsApiLoader } from "@react-google-maps/api";
import { useEffect, useRef, useState } from "react";
import MapView from "@/components/MapView";
import {
  SF_DANGEROUS_NEIGHBORHOODS,
  neighborhoodRiskColor,
  neighborhoodRiskLabel,
} from "@/lib/data/sfDangerousNeighborhoods";
import { createGoogleDirectionsRouter } from "@/lib/googleDirections";
import { DEMO_CITY } from "@/lib/mockData";
import { computeRouteOptions, improvedRiskPercent } from "@/lib/routing";
import type {
  BikeLaneSegment,
  DangerZone,
  HighwaySegment,
  LatLng,
  NamedDangerLocation,
  RouteOptionKind,
  RouteRiskResult,
} from "@/lib/types";

const LIBRARIES: "places"[] = ["places"];

// Biases (not restricts, since strictBounds is off) the address autocomplete
// toward San Francisco - reads directly from DEMO_CITY so this always
// matches the same bounds the danger-zone grid actually samples over.
const SF_BOUNDS: google.maps.LatLngBoundsLiteral = DEMO_CITY.bounds;

interface LayersResponse {
  city: { name: string; center: { lat: number; lng: number } };
  dangerZones: DangerZone[];
  highways: HighwaySegment[];
  bikeLanes: BikeLaneSegment[];
  namedDangerLocations: NamedDangerLocation[];
}

// The 3 route choices, in the order they're revealed: Google's own route
// resolves first (near-instant), then the two safety tiers stream in after.
const ROUTE_TABS: { kind: RouteOptionKind; label: string }[] = [
  { kind: "fastest", label: "Fastest (Google)" },
  { kind: "balancedSafe", label: "Overall best safe route" },
  { kind: "safest", label: "Absolute safest route" },
];

type PartialRouteState = Partial<Record<RouteOptionKind, RouteRiskResult>>;

function metersToMiles(m: number): string {
  return (m / 1609.34).toFixed(1);
}

function secondsToMinutes(s: number): string {
  return Math.round(s / 60).toString();
}

/** e.g. "+4 min" / "-2 min" / "same time" relative to Google's route. */
function timeDiffLabel(current: RouteRiskResult, baseline: RouteRiskResult): string {
  const diffMin = Math.round((current.durationSeconds - baseline.durationSeconds) / 60);
  if (diffMin === 0) return "same time";
  return diffMin > 0 ? `+${diffMin} min` : `${diffMin} min`;
}

const BIKE_LANE_TIER_LABEL: Record<string, string> = {
  fullyProtected: "fully protected",
  semiProtected: "semi protected",
  unprotected: "unprotected",
  none: "no lane",
};

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
  const [routes, setRoutes] = useState<PartialRouteState>({});
  const [selectedRouteKind, setSelectedRouteKind] = useState<RouteOptionKind>("fastest");
  const [confirmed, setConfirmed] = useState(false);
  const [computingSafer, setComputingSafer] = useState(false);
  const [routingError, setRoutingError] = useState<string | null>(null);

  const originAutocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const destinationAutocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const directionsServiceRef = useRef<google.maps.DirectionsService | null>(null);
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

  function placeToLatLng(place: google.maps.places.PlaceResult | undefined): LatLng | null {
    const location = place?.geometry?.location;
    return location ? { lat: location.lat(), lng: location.lng() } : null;
  }

  function resetRouteState() {
    routeRequestIdRef.current++; // invalidate any in-flight search
    setRoutes({});
    setSelectedRouteKind("fastest");
    setConfirmed(false);
    setComputingSafer(false);
    setRoutingError(null);
  }

  async function startRouteSearch(from: LatLng, to: LatLng) {
    const requestId = ++routeRequestIdRef.current;
    setRoutes({});
    setSelectedRouteKind("fastest");
    setConfirmed(false);
    setRoutingError(null);
    setComputingSafer(true);

    try {
      const layers = await ensureLayersLoaded();
      if (requestId !== routeRequestIdRef.current) return;

      if (!directionsServiceRef.current) {
        directionsServiceRef.current = new google.maps.DirectionsService();
      }
      const requestRoute = createGoogleDirectionsRouter(directionsServiceRef.current);

      const options = await computeRouteOptions(
        requestRoute,
        from,
        to,
        layers.dangerZones,
        {
          onFastest: (fastest) => {
            if (requestId !== routeRequestIdRef.current) return;
            setRoutes((prev) => ({ ...prev, fastest }));
          },
          onBalancedSafe: (balancedSafe) => {
            if (requestId !== routeRequestIdRef.current) return;
            setRoutes((prev) => ({ ...prev, balancedSafe }));
          },
        },
        {
          highways: layers.highways,
          bikeLanes: layers.bikeLanes,
          namedLocations: layers.namedDangerLocations,
        }
      );
      if (requestId !== routeRequestIdRef.current) return; // a newer search already won
      setRoutes(options);
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

  // Google's Places `place_changed` event only fires when the user picks a
  // suggestion from the dropdown - if they instead retype over an address
  // and just hit Enter or click away, our `origin`/`destination` state would
  // otherwise silently keep pointing at the *old* selected place. Clearing
  // on every keystroke forces a fresh, real selection before a new search
  // can run.
  function handleAddressInputChange(which: "origin" | "destination") {
    if (which === "origin") updateOrigin(null);
    else updateDestination(null);
  }

  function selectRouteTab(kind: RouteOptionKind) {
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
          {isLoaded && (
            <>
              <Autocomplete
                onLoad={(ac) => (originAutocompleteRef.current = ac)}
                onPlaceChanged={() =>
                  updateOrigin(placeToLatLng(originAutocompleteRef.current?.getPlace()))
                }
                bounds={SF_BOUNDS}
                options={{ strictBounds: false }}
              >
                <input
                  type="text"
                  placeholder="Start address (A)"
                  onChange={() => handleAddressInputChange("origin")}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-black"
                />
              </Autocomplete>
              <Autocomplete
                onLoad={(ac) => (destinationAutocompleteRef.current = ac)}
                onPlaceChanged={() =>
                  updateDestination(placeToLatLng(destinationAutocompleteRef.current?.getPlace()))
                }
                bounds={SF_BOUNDS}
                options={{ strictBounds: false }}
              >
                <input
                  type="text"
                  placeholder="Destination address (B)"
                  onChange={() => handleAddressInputChange("destination")}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-black"
                />
              </Autocomplete>
            </>
          )}
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
                        ? `${metersToMiles(route.distanceMeters)} mi · ${secondsToMinutes(route.durationSeconds)} min`
                        : tab.kind === "fastest"
                          ? "…"
                          : computingSafer
                            ? "Computing…"
                            : "—"}
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
                  <span>Time</span>
                  <span className="font-medium">{secondsToMinutes(activeRoute.durationSeconds)} min</span>
                </div>
                {selectedRouteKind !== "fastest" && routes.fastest && (
                  <div className="flex justify-between">
                    <span>Time vs Google&apos;s route</span>
                    <span className="font-medium">{timeDiffLabel(activeRoute, routes.fastest)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Risk score</span>
                  <span className="font-medium">{activeRoute.riskScore}</span>
                </div>
                <div className="flex justify-between">
                  <span>Danger zones crossed</span>
                  <span className="font-medium">{activeRoute.zonesCrossed.length}</span>
                </div>
                {selectedRouteKind !== "fastest" && routes.fastest && (
                  <p className="mt-1 font-medium">
                    {improvedRiskPercent(routes.fastest, activeRoute) > 0
                      ? `${improvedRiskPercent(routes.fastest, activeRoute)}% less danger-zone risk than Google's route.`
                      : "Same risk as Google's route - it was already clear of danger zones."}
                  </p>
                )}

                {selectedRouteKind !== "fastest" && (
                  <div className="mt-1 flex flex-col gap-0.5 border-t border-slate-200 pt-1.5">
                    <span className="font-semibold">Bike lanes used</span>
                    {activeRoute.bikeLanesUsed && activeRoute.bikeLanesUsed.length > 0 ? (
                      <ul className="list-disc pl-4">
                        {activeRoute.bikeLanesUsed.map((lane) => (
                          <li key={lane.name}>
                            {lane.name}{" "}
                            <span className="text-black/60">({BIKE_LANE_TIER_LABEL[lane.tier] ?? lane.tier})</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-black/60">None along this route.</span>
                    )}
                  </div>
                )}

                {selectedRouteKind !== "fastest" && (
                  <div className="mt-1 flex flex-col gap-0.5 border-t border-slate-200 pt-1.5">
                    <span className="font-semibold">Neighborhoods avoided</span>
                    {activeRoute.neighborhoodsAvoided && activeRoute.neighborhoodsAvoided.length > 0 ? (
                      <ul className="list-disc pl-4">
                        {activeRoute.neighborhoodsAvoided.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-black/60">
                        Google&apos;s route didn&apos;t cross any known dangerous area here.
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

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
              Turn-by-turn directions
            </h2>
            <ol className="flex flex-col gap-2 text-xs text-black">
              {activeRoute.steps.map((step, i) => (
                <li key={i} className="flex gap-2 border-b border-slate-100 pb-2 last:border-0">
                  <span className="font-semibold text-black">{i + 1}.</span>
                  <span>
                    {step.instructions}
                    {step.distanceMeters > 0 && (
                      <span className="text-black/60"> ({metersToMiles(step.distanceMeters)} mi)</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <p className="mt-auto text-[11px] leading-snug text-black">
          Routes are computed with Google&apos;s Directions API, then adjusted using a demo danger
          model built on real San Francisco street data from{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            © OpenStreetMap contributors
          </a>
          . Crash/infrastructure scores are synthetic demo data. Not for real navigation decisions.
        </p>
      </aside>

      <main className="flex-1">
        <MapView
          center={data?.city.center ?? { lat: 37.7749, lng: -122.4194 }}
          isLoaded={isLoaded}
          origin={origin}
          destination={destination}
          selectedRoute={activeRoute ? { kind: selectedRouteKind, path: activeRoute.path } : null}
          dangerZones={showNeighborhoodView ? (data?.dangerZones ?? []) : []}
          dangerousNeighborhoods={showNeighborhoodView ? SF_DANGEROUS_NEIGHBORHOODS : []}
        />
      </main>
    </div>
  );
}
