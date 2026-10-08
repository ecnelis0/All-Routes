"use client";

import { useJsApiLoader } from "@react-google-maps/api";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import AddressSearch from "@/components/AddressSearch";
import MapView, { type MapPlace } from "@/components/MapView";
import { RouteChoiceList } from "@/components/RouteChoices";
import SaveRouteButton from "@/components/SaveRouteButton";
import { shortPlace } from "@/lib/saved/store";
import { emojiFor, INTERESTS, type InterestId, type InterestRide } from "@/lib/interests/catalog";
import type { RouteSummary } from "@/lib/routing/service";
import { describeRoute } from "@/lib/ui/routeDescription";
import { rideMinutes } from "@/lib/ui/rideTime";
import { useTestMode } from "@/lib/ui/useTestMode";
import type { LatLng } from "@/lib/types";

const NavigationView = dynamic(() => import("@/components/NavigationView"), { ssr: false });

/**
 * EXPLORE: rides shaped around what the rider likes - a separate mode from
 * the safety router on "/", though it plans on the same engine and keeps
 * the same safety rules between stops. See lib/interests/planner.ts.
 */

// Must match the loader options on "/" exactly - the Google loader is a
// singleton and refuses a second, different configuration.
const LIBRARIES: [] = [];
const miles = (m: number) => (m / 1609.34).toFixed(1);

type Ride = InterestRide & { route: RouteSummary };

export default function ExplorePage() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const { isLoaded } = useJsApiLoader({ id: "google-map-script", googleMapsApiKey: apiKey ?? "", libraries: LIBRARIES });

  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [originText, setOriginText] = useState("");
  const [destinationText, setDestinationText] = useState("");
  const [interests, setInterests] = useState<InterestId[]>([]);
  const [rides, setRides] = useState<Ride[] | null>(null);
  const [picked, setPicked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navSource, setNavSource] = useState<"gps" | "simulate" | null>(null);
  const testMode = useTestMode();
  const requestIdRef = useRef(0);

  function toggle(id: InterestId) {
    setInterests((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
    setRides(null);
  }

  async function plan() {
    if (!origin || !destination || interests.length === 0) return;
    const id = ++requestIdRef.current;
    setBusy(true);
    setError(null);
    setRides(null);
    try {
      const res = await fetch("/api/interests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, destination, interests }),
      });
      const json = (await res.json()) as { rides?: Ride[]; error?: string };
      if (id !== requestIdRef.current) return;
      if (!res.ok) setError(json.error ?? `Could not plan a ride (${res.status}).`);
      else {
        setRides(json.rides ?? []);
        setPicked(0);
      }
    } catch (e) {
      if (id === requestIdRef.current) setError(e instanceof Error ? e.message : "Could not plan a ride.");
    } finally {
      if (id === requestIdRef.current) setBusy(false);
    }
  }

  const ride = rides?.[picked] ?? null;
  // The description's "stops you chose" line is for hand-edited routes;
  // these stops were picked for the rider, so it is left off here.
  const description = ride
    ? describeRoute({ ...ride.route, customWaypoints: undefined }, String(rideMinutes(ride.route)))
    : null;
  const places: MapPlace[] = ride
    ? [
        ...ride.stops.map((p, i) => ({ id: p.id, name: p.name, emoji: emojiFor(p.category), position: p, stopNumber: i + 1 })),
        ...ride.along.map((p) => ({ id: p.id, name: p.name, emoji: emojiFor(p.category), position: p })),
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-4 text-black">
        <div>
          <h1 className="text-lg font-semibold">Explore rides</h1>
          <p className="text-xs text-black/60">A route made around what you like. The safety rules still apply.</p>
        </div>

        <section className="flex flex-col gap-2">
          <AddressSearch
            placeholder="Start address (A)"
            value={originText}
            onValueChange={setOriginText}
            onSelect={(p) => {
              setOrigin(p);
              setRides(null);
            }}
          />
          <AddressSearch
            placeholder="Destination address (B)"
            value={destinationText}
            onValueChange={setDestinationText}
            onSelect={(p) => {
              setDestination(p);
              setRides(null);
            }}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide">What do you like?</h2>
          <div className="flex flex-wrap gap-1.5">
            {INTERESTS.map((i) => {
              const on = interests.includes(i.id);
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => toggle(i.id)}
                  aria-pressed={on}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white hover:bg-slate-50"
                  }`}
                >
                  {i.emoji} {i.label}
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-1 text-xs text-black/60">
            <span>
              Or describe your ride <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold">coming soon</span>
            </span>
            <textarea
              disabled
              rows={2}
              placeholder="e.g. a sunny ride along the ocean with a good boba stop - AI will plan it with Google Maps"
              className="resize-none rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs"
            />
          </label>
          <button
            type="button"
            onClick={() => void plan()}
            disabled={!origin || !destination || interests.length === 0 || busy}
            className="rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy ? "Finding places on your way…" : "Plan my ride"}
          </button>
          {error && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
        </section>

        {rides && rides.length > 0 && ride && description && (
          <section className="flex flex-col gap-2" data-testid="explore-results">
            <div className="grid grid-cols-1 gap-1.5">
              {rides.map((r, i) => (
                <button
                  key={r.style}
                  type="button"
                  onClick={() => setPicked(i)}
                  aria-pressed={picked === i}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                    picked === i ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{r.styleLabel}</span>
                    <span className="text-[10px] text-black/55">
                      {r.stops.length} stop{r.stops.length === 1 ? "" : "s"} · +{r.extraPercent}% vs the plain route
                    </span>
                  </span>
                  <span className="text-[11px]">
                    {miles(r.route.distanceMeters)} mi · ~{rideMinutes(r.route)} min
                  </span>
                </button>
              ))}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <p className="mb-1 font-semibold">Stops</p>
              {ride.stops.length > 0 ? (
                <ol className="flex flex-col gap-1" data-testid="explore-stops">
                  {ride.stops.map((p, i) => (
                    <li key={p.id} className="flex gap-1.5">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-600 text-[10px] font-bold text-white">
                        {i + 1}
                      </span>
                      <span>
                        {emojiFor(p.category)} {p.name}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-black/60">
                  Nothing you picked is close enough to this trip to be worth the detour.
                </p>
              )}
              {ride.along.length > 0 && (
                <>
                  <p className="mb-1 mt-2 font-semibold">Also along the way</p>
                  <p className="leading-snug text-black/70">
                    {ride.along
                      .slice(0, 12)
                      .map((p) => `${emojiFor(p.category)} ${p.name}`)
                      .join(" · ")}
                    {ride.along.length > 12 && ` · and ${ride.along.length - 12} more`}
                  </p>
                </>
              )}
              <div className="mt-2 border-t border-slate-200 pt-2">
                <RouteChoiceList description={description} />
              </div>
              <p className="mt-2 text-[10px] text-black/50">
                Places from OpenStreetMap. Ratings and &ldquo;is it actually good&rdquo; arrive with the AI planner.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNavSource("gps")}
                className="flex-1 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white"
              >
                Start navigation
              </button>
              {testMode && (
                <button
                  type="button"
                  onClick={() => setNavSource("simulate")}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
                >
                  Simulate ride
                </button>
              )}
            </div>
            {origin && destination && (
              <SaveRouteButton
                key={`${ride.style}-${ride.route.distanceMeters}`}
                defaultName={`${shortPlace(originText)} → ${shortPlace(destinationText)} · ${ride.route.label}`}
                build={() => ({
                  from: { label: originText, point: origin },
                  to: { label: destinationText, point: destination },
                  settings: { avoidElevation: false, fewerSignals: false },
                  source: "explore",
                  route: ride.route,
                  places: ride.stops,
                })}
              />
            )}
          </section>
        )}
      </aside>

      <main className="relative min-h-0 flex-1">
        <MapView
          center={{ lat: 37.7749, lng: -122.4194 }}
          isLoaded={isLoaded}
          origin={origin}
          destination={destination}
          routes={ride && description ? [{ kind: "custom", path: ride.route.path, description }] : []}
          selectedKind={ride ? "custom" : null}
          focused
          places={places}
        />
        {navSource && ride && destination && (
          <NavigationView
            route={ride.route}
            destination={destination}
            source={navSource}
            avoidElevation={false}
            fewerSignals={false}
            details={description ?? undefined}
            waypoints={ride.route.customWaypoints}
            onExit={() => setNavSource(null)}
          />
        )}
      </main>
    </div>
  );
}
