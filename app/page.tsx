"use client";

import { useJsApiLoader } from "@react-google-maps/api";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import AddressSearch from "@/components/AddressSearch";
import MapView, { type MapPlace, type MapRoute, type MapRouteKind, type RoutePopup } from "@/components/MapView";
import type { SuggestedEdit } from "@/lib/routing/suggest";
import type { WikiPlace } from "@/lib/places/wikipedia";
import { emojiFor, INTERESTS, type InterestId, type InterestRide } from "@/lib/interests/catalog";
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
import { rideMinutes, rideSeconds, type TimedRoute } from "@/lib/ui/rideTime";
import { useTestMode } from "@/lib/ui/useTestMode";
import { percentToDegrees } from "@/lib/tour/elevationProfile";
import { insertWaypoint } from "@/lib/ui/geometry";
import { RouteChoiceList } from "@/components/RouteChoices";
import RouteCompare from "@/components/RouteCompare";
import SaveRouteButton from "@/components/SaveRouteButton";
import { shortPlace } from "@/lib/saved/store";
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
  { kind: "fastest", label: "Fastest", hint: "Quickest ride, counting hills and red lights" },
  // Matches the area rules in lib/routing/service.ts (AREA_DETOUR_LIMIT).
  { kind: "balanced", label: "Safest", hint: "Never Severe areas; others unless the detour passes 40%" },
  { kind: "safest", label: "Safest + bike lanes", hint: "Same, and keeps to protected lanes" },
];

function metersToMiles(m: number): string {
  return (m / 1609.34).toFixed(1);
}

function secondsToMinutes(s: number): string {
  return Math.round(s / 60).toString();
}

/**
 * Minutes from the router's estimate: distance, climbing and traffic-light
 * waits (lib/ui/rideTime.ts). It is the same number "Fastest" minimises.
 */
function estimateMinutes(route: TimedRoute): string {
  return String(rideMinutes(route));
}

/** e.g. "+4 min" / "-2 min" / "same time" relative to the fastest route. */
function timeDiffLabel(current: RouteSummary, baseline: RouteSummary): string {
  const diffMin = Math.round((rideSeconds(current) - rideSeconds(baseline)) / 60);
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
  const testMode = useTestMode();
  /** Routes the rider took off the map. Reset by every new search. */
  const [hiddenRoutes, setHiddenRoutes] = useState<RouteKey[]>([]);
  const [routePopup, setRoutePopup] = useState<RoutePopup | null>(null);
  /**
   * A route has been SELECTED: only it is on the map, and it can be
   * toured, navigated or edited. "Show all routes" goes back.
   */
  const [focused, setFocused] = useState(false);
  // "For you": interests shape an extra route alongside the three options,
  // planned with the same hill/light settings and safety rules.
  const [interests, setInterests] = useState<InterestId[]>([]);
  const [interestRides, setInterestRides] = useState<(InterestRide & { route: RouteSummary })[] | null>(null);
  const [interestStyle, setInterestStyle] = useState(0);
  const [interestBusy, setInterestBusy] = useState(false);
  const interestRequestIdRef = useRef(0);
  const [compareOpen, setCompareOpen] = useState(false);
  // Places along the way (Wikipedia), fetched only when asked for, per route.
  const [showPlaces, setShowPlaces] = useState(false);
  const [wikiPlaces, setWikiPlaces] = useState<{ key: string; places: WikiPlace[] } | null>(null);
  /** The 3D tour's own "Places" button asks for them even if the map pins are off. */
  const [tourWantsPlaces, setTourWantsPlaces] = useState(false);
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
  // Suggested edits: nothing is computed or shown until the rider asks.
  const [suggestions, setSuggestions] = useState<SuggestedEdit[] | null>(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [openSuggestionId, setOpenSuggestionId] = useState<string | null>(null);
  const suggestRequestIdRef = useRef(0);
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

  // Wikipedia places for the route being looked at, once wanted. State is
  // only set after the fetch returns, and a stale answer for a route no
  // longer on screen is dropped.
  const wantPlaces = showPlaces || tourWantsPlaces;
  const placesRoute = editing ? (draftRoute ?? editOriginal) : routeFor(selectedRouteKind);
  const placesKey = placesRoute ? routeKey(placesRoute) : null;
  useEffect(() => {
    if (!wantPlaces || !placesRoute || !placesKey || wikiPlaces?.key === placesKey) return;
    let cancelled = false;
    fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: placesRoute.path }),
    })
      .then((res) => res.json() as Promise<{ places?: WikiPlace[] }>)
      .then((json) => {
        if (!cancelled) setWikiPlaces({ key: placesKey, places: json.places ?? [] });
      })
      .catch(() => {
        if (!cancelled) setWikiPlaces({ key: placesKey, places: [] });
      });
    return () => {
      cancelled = true;
    };
    // placesRoute is identified by placesKey; refetch only when that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPlaces, placesKey, wikiPlaces?.key]);

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
    setCompareOpen(false);
    setCustomRoute(null);
    exitEditing();
    interestRequestIdRef.current++;
    setInterestRides(null);
    setInterestBusy(false);
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
    void planInterests(from, to, interests, hills, lights);
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

  async function planInterests(from: LatLng, to: LatLng, list: InterestId[], hills: boolean, lights: boolean) {
    const id = ++interestRequestIdRef.current;
    setInterestRides(null);
    if (list.length === 0) {
      setInterestBusy(false);
      return;
    }
    setInterestBusy(true);
    try {
      const res = await fetch("/api/interests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: from, destination: to, interests: list, avoidElevation: hills, fewerSignals: lights }),
      });
      const json = (await res.json()) as { rides?: (InterestRide & { route: RouteSummary })[] };
      if (id !== interestRequestIdRef.current) return;
      setInterestRides(res.ok ? (json.rides ?? []) : []);
      setInterestStyle(0);
    } catch {
      if (id === interestRequestIdRef.current) setInterestRides([]);
    } finally {
      if (id === interestRequestIdRef.current) setInterestBusy(false);
    }
  }

  function toggleInterest(id: InterestId) {
    const next = interests.includes(id) ? interests.filter((x) => x !== id) : [...interests, id];
    setInterests(next);
    if (selectedRouteKind === "interest") {
      setSelectedRouteKind("fastest");
      setFocused(false);
    }
    if (origin && destination) void planInterests(origin, destination, next, avoidElevation, fewerSignals);
  }

  function routeKey(r: RouteSummary): string {
    return `${r.distanceMeters}-${r.path.length}-${r.path[0]?.lat}-${r.path.at(-1)?.lat}`;
  }

  function routeFor(kind: RouteKey): RouteSummary | null {
    if (kind === "interest") return interestRides?.[interestStyle]?.route ?? null;
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
  function clearSuggestions() {
    suggestRequestIdRef.current++;
    setSuggestions(null);
    setSuggestBusy(false);
    setSuggestError(null);
    setOpenSuggestionId(null);
  }

  function exitEditing() {
    clearSuggestions();
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
    setCompareOpen(false);
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

  async function findSuggestions() {
    if (!origin || !destination) return;
    const id = ++suggestRequestIdRef.current;
    setSuggestBusy(true);
    setSuggestError(null);
    setOpenSuggestionId(null);
    try {
      const res = await fetch("/api/route/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          destination,
          waypoints: editStops,
          profile: editProfile,
          avoidElevation,
          fewerSignals,
          accepted: (draftRoute ?? editOriginal)?.acceptedSuggestions ?? [],
          // Measure against exactly the route on screen.
          basePath: (draftRoute ?? editOriginal)?.path,
        }),
      });
      const json = (await res.json()) as { suggestions?: SuggestedEdit[]; error?: string };
      if (id !== suggestRequestIdRef.current) return;
      if (!res.ok) setSuggestError(json.error ?? `Could not find suggestions (${res.status}).`);
      else setSuggestions(json.suggestions ?? []);
    } catch (err) {
      if (id === suggestRequestIdRef.current) setSuggestError(err instanceof Error ? err.message : "Could not find suggestions.");
    } finally {
      if (id === suggestRequestIdRef.current) setSuggestBusy(false);
    }
  }

  function applySuggestion(id: string) {
    const sg = suggestions?.find((x) => x.id === id);
    if (!sg) return;
    draftRequestIdRef.current++; // an in-flight re-plan must not overwrite this
    setDraftRoute(sg.route);
    setEditStops(sg.route.customWaypoints ?? editStops);
    setDraftError(null);
    // The other suggestions were measured against the old route.
    clearSuggestions();
  }

  function updateStops(next: LatLng[]) {
    // Suggestions were measured against the route before this change.
    clearSuggestions();
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

  const describe = (route: RouteSummary) => describeRoute(route, estimateMinutes(route));
  const selectedRoute = routeFor(selectedRouteKind);
  // While editing, the route on screen (and in the sidebar) is the edited
  // draft - or the original until the first stop is added.
  const activeRoute = editing ? (draftRoute ?? editOriginal) : selectedRoute;
  const interestRide = interestRides?.[interestStyle] ?? null;
  const interestLabel = INTERESTS.filter((i) => interests.includes(i.id))
    .map((i) => i.emoji)
    .join(" ");
  const tabs: { kind: RouteKey; label: string; hint: string }[] = [
    ...ROUTE_TABS,
    ...(interests.length > 0
      ? [
          {
            kind: "interest" as const,
            label: `For you ${interestLabel}`,
            hint: interestRide
              ? `${interestRide.styleLabel} · ${interestRide.stops.length} stop${interestRide.stops.length === 1 ? "" : "s"} you'd like`
              : "Places you like, on the way",
          },
        ]
      : []),
    ...(customRoute ? [{ kind: "custom" as const, label: "My route", hint: "Your edited route" }] : []),
  ];
  // Pins for the "For you" ride when it is the one being looked at.
  const showRidePins = !editing && selectedRouteKind === "interest" && interestRide;
  const places: MapPlace[] = showRidePins
    ? [
        ...interestRide.stops.map((p, i) => ({ id: p.id, name: p.name, emoji: emojiFor(p.category), position: p, stopNumber: i + 1 })),
        ...interestRide.along.map((p) => ({ id: p.id, name: p.name, emoji: emojiFor(p.category), position: p })),
      ]
    : [];
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
  // Places shown belong to the route being looked at - never another one's.
  const placesForActive = activeRoute && wikiPlaces?.key === routeKey(activeRoute) ? wikiPlaces.places : null;

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
          <button
            type="button"
            onClick={() => setShowPlaces((v) => !v)}
            aria-pressed={showPlaces}
            disabled={!activeRoute}
            className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50 ${
              showPlaces ? "border-teal-600 bg-teal-50 text-black" : "border-slate-200 bg-white text-black hover:bg-slate-50"
            }`}
          >
            <span className="flex flex-col">
              <span className="font-medium">Places along the way</span>
              <span className="text-[10px] text-black/55">Photos and why go, from Wikipedia</span>
            </span>
            <span className="text-[11px] text-black">
              {showPlaces ? (placesForActive ? `${placesForActive.length} shown` : "Loading…") : "Show"}
            </span>
          </button>
          <div className="flex flex-col gap-1.5" data-testid="interests">
            <span className="text-xs font-semibold uppercase tracking-wide text-black">What do you like?</span>
            <div className="flex flex-wrap gap-1">
              {INTERESTS.map((i) => {
                const on = interests.includes(i.id);
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => toggleInterest(i.id)}
                    aria-pressed={on}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white text-black hover:bg-slate-50"
                    }`}
                  >
                    {i.emoji} {i.label}
                  </button>
                );
              })}
            </div>
            {interests.length > 0 && (
              <span className="text-[10px] text-black/55">
                Adds a &ldquo;For you&rdquo; route that passes places you like - same safety rules, same hill
                and light settings.
              </span>
            )}
          </div>
          {showNeighborhoodView && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] leading-snug text-black">
                Labelled circles are flagged neighbourhoods; small unlabelled circles are
                crash hotspots (clusters of real bike crashes). The safer routes never enter
                Severe areas, and stay out of everything else unless that makes the trip more
                than 40% longer than Fastest - then they say where they went through and why.
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
                      <span className="font-medium">{tab.kind === "interest" ? tab.label : (route?.label ?? tab.label)}</span>
                      <span className="text-[10px] text-black/55">
                        {route && hiddenRoutes.includes(tab.kind) ? "Removed from map \u00b7 click to show" : tab.hint}
                      </span>
                    </span>
                    <span className="text-[11px] text-black">
                      {route
                        ? `${metersToMiles(route.distanceMeters)} mi \u00b7 ~${estimateMinutes(route)} min`
                        : computingSafer || (tab.kind === "interest" && interestBusy)
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
            {!editing && tabs.filter((t) => routeFor(t.kind)).length >= 2 && (
              <button
                type="button"
                onClick={() => {
                  setCompareOpen((o) => !o);
                  setTourOpen(false);
                }}
                aria-pressed={compareOpen}
                className={`rounded-md border px-3 py-2 text-sm font-medium ${
                  compareOpen
                    ? "border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                    : "border-slate-300 bg-white text-black hover:bg-slate-50"
                }`}
              >
                {compareOpen ? "Close comparison" : "Compare routes side by side"}
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
                        ["Dropping", `${Math.round(editOriginal.elevationLossMeters * 3.281)} ft`, `${Math.round(draftRoute.elevationLossMeters * 3.281)} ft`],
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

                <div className="flex flex-col gap-1.5 border-t border-violet-200 pt-2" data-testid="suggestions-panel">
                  {suggestions === null ? (
                    <button
                      type="button"
                      onClick={() => void findSuggestions()}
                      disabled={suggestBusy || draftBusy}
                      className="rounded-md border border-orange-500 bg-white px-2 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-50 disabled:opacity-50"
                    >
                      {suggestBusy ? "Checking every alternative…" : "Show suggested edits"}
                    </button>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">Suggested edits</span>
                        <button
                          type="button"
                          onClick={clearSuggestions}
                          className="text-[11px] font-medium text-orange-700 hover:underline"
                        >
                          Hide
                        </button>
                      </div>
                      {suggestions.length === 0 ? (
                        <p className="text-black/60">
                          No worthwhile changes: every alternative was slower, hillier or riskier
                          than this route without a real gain.
                        </p>
                      ) : (
                        <ol className="flex flex-col gap-1">
                          {suggestions.map((sg, i) => (
                            <li key={sg.id}>
                              <button
                                type="button"
                                onClick={() => setOpenSuggestionId(openSuggestionId === sg.id ? null : sg.id)}
                                aria-expanded={openSuggestionId === sg.id}
                                className={`flex w-full gap-1.5 rounded px-1.5 py-1 text-left leading-snug ${
                                  openSuggestionId === sg.id ? "bg-orange-100" : "hover:bg-orange-50"
                                }`}
                              >
                                <span className="mt-0.5 shrink-0 rounded bg-orange-600 px-1 text-[10px] font-bold text-white">
                                  S{i + 1}
                                </span>
                                <span>{sg.headline}</span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                      <p className="text-[10px] text-black/50">
                        Click a suggestion, or its checkpoint on the map, to see the alternative.
                      </p>
                    </>
                  )}
                  {suggestError && <p className="rounded bg-red-50 px-2 py-1 text-red-700">{suggestError}</p>}
                </div>

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
                {selectedRouteKind === "interest" && !editing && interestRides && interestRides.length > 1 && (
                  <div className="mb-1 flex gap-1" role="group" aria-label="Ride style">
                    {interestRides.map((r, i) => (
                      <button
                        key={r.style}
                        type="button"
                        onClick={() => setInterestStyle(i)}
                        aria-pressed={interestStyle === i}
                        className={`flex-1 rounded border px-2 py-1 text-[11px] ${
                          interestStyle === i ? "border-teal-600 bg-teal-50 font-semibold" : "border-slate-300 bg-white"
                        }`}
                      >
                        {r.styleLabel} · {r.stops.length} stop{r.stops.length === 1 ? "" : "s"} · +{r.extraPercent}%
                      </button>
                    ))}
                  </div>
                )}
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
                  <span className="font-medium">~{estimateMinutes(activeRoute)} min</span>
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
                  <span>Elevation change</span>
                  <span className="font-medium" title="Climbed / dropped">
                    ▲ {Math.round(activeRoute.elevationGainMeters * 3.281)} ft · ▼{" "}
                    {Math.round(activeRoute.elevationLossMeters * 3.281)} ft
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Steepest climb</span>
                  <span
                    className={`font-medium ${activeRoute.maxGradePercent >= 12 ? "text-red-600" : ""}`}
                  >
                    {activeRoute.maxGradePercent}% ({percentToDegrees(activeRoute.maxGradePercent).toFixed(1)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Steepest descent</span>
                  <span
                    className={`font-medium ${activeRoute.maxDownGradePercent >= 12 ? "text-red-600" : ""}`}
                  >
                    {activeRoute.maxDownGradePercent}% ({percentToDegrees(activeRoute.maxDownGradePercent).toFixed(1)}°)
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
                          <span
                            className={`rounded px-1 text-[10px] font-semibold ${
                              n.tier === "Severe"
                                ? "bg-red-100 text-red-800"
                                : n.tier === "High"
                                  ? "bg-orange-100 text-orange-800"
                                  : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {n.tier}
                          </span>{" "}
                          <span className="text-black/60">
                            ({metersToMiles(n.meters)} mi{n.atEndpoint ? ", trip starts or ends here" : ""})
                          </span>
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
              onClick={() => {
                setTourOpen((open) => !open);
                setCompareOpen(false);
              }}
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
              {testMode && (
                <button
                  type="button"
                  onClick={() => setNavSource("simulate")}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-black hover:bg-slate-50"
                >
                  Simulate ride
                </button>
              )}
            </div>
            {origin && destination && (
              <SaveRouteButton
                // A different route starts unsaved.
                key={`${activeRoute.label}-${activeRoute.distanceMeters}-${activeRoute.path.length}`}
                defaultName={`${shortPlace(originText)} → ${shortPlace(destinationText)} · ${activeRoute.label.replace(/ · best effort$/, "")}`}
                build={() => ({
                  from: { label: originText, point: origin },
                  to: { label: destinationText, point: destination },
                  settings: { avoidElevation, fewerSignals },
                  source: selectedRouteKind === "interest" ? "explore" : "route",
                  route: activeRoute,
                  ...(selectedRouteKind === "interest" && interestRide ? { places: interestRide.stops } : {}),
                })}
              />
            )}
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
          suggestions={
            editing && suggestions
              ? suggestions.map((sg, i) => ({
                  id: sg.id,
                  label: `S${i + 1}`,
                  headline: sg.headline,
                  gains: sg.gains,
                  costs: sg.costs,
                  checkpoint: sg.checkpoint,
                  sectionPath: sg.sectionPath,
                  replacedPath: sg.replacedPath,
                }))
              : []
          }
          openSuggestionId={openSuggestionId}
          onOpenSuggestion={setOpenSuggestionId}
          onUseSuggestion={applySuggestion}
          places={places}
          wikiPlaces={showPlaces && placesForActive ? placesForActive : []}
          dangerZones={showNeighborhoodView ? (data?.dangerZones ?? []) : []}
          dangerousNeighborhoods={showNeighborhoodView ? SF_DANGEROUS_NEIGHBORHOODS : []}
        />
        {compareOpen && !editing && (
          <RouteCompare
            items={tabs.flatMap((t) => {
              const route = routeFor(t.kind);
              return route ? [{ kind: t.kind, route, description: describe(route) }] : [];
            })}
            onSelect={(kind) => {
              selectRoute(kind);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        )}
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
            places={placesForActive}
            onWantPlaces={() => setTourWantsPlaces(true)}
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
