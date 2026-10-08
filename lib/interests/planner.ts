import { planCustomPath, summarizeCustom, RoutingError, type PlanOptions, type RouteSummary } from "../routing/service";
import { SF_DANGEROUS_NEIGHBORHOODS } from "../data/sfDangerousNeighborhoods";
import { areaTier } from "../routing/service";
import { alongPath, distanceToPath } from "../ui/geometry";
import type { LatLng } from "../types";
import poiFile from "../data/sfPois.json";

/**
 * INTEREST ROUTES: a ride shaped around what the rider likes - beaches,
 * boba, parks, bike paths - rather than only around danger.
 *
 * Two kinds of interest:
 *   - places (beach, boba, coffee, food, park, viewpoint, art): the route
 *     is sent THROUGH a few well-placed ones, chosen near the direct line,
 *     spread along the trip and kept within a detour budget;
 *   - bike paths: the route prefers protected lanes and car-free paths
 *     (the "Safest + bike lanes" rules).
 *
 * Every leg between places is planned by the same engine as everything
 * else, so the safety rules still hold: Severe areas are never entered,
 * and a place inside one is never chosen.
 *
 * Places come from OpenStreetMap (names, types, positions - no ratings).
 * The planned AI step replaces "closest to the line" with "actually good",
 * using Google Maps; the selection here is deliberately simple and honest
 * about what it knows.
 */

import { emojiFor, INTERESTS, type InterestId, type PlaceInterest, type Poi } from "./catalog";
export { INTERESTS, type InterestId, type PlaceInterest, type Poi } from "./catalog";


export type RideStyle = "quick" | "relaxed";

/**
 * How far each style goes for the rider's interests. "Corridor" is how far
 * from the direct line a place may be; the detour budget is an estimate of
 * extra riding (twice the distance off the line, there and back).
 */
export const STYLE: Record<RideStyle, { label: string; maxStops: number; perCategory: number; corridor: number; corridorMax: number; budget: number }> = {
  quick: { label: "Quick", maxStops: 2, perCategory: 1, corridor: 0.08, corridorMax: 400, budget: 0.15 },
  relaxed: { label: "Relaxed", maxStops: 5, perCategory: 2, corridor: 0.25, corridorMax: 1500, budget: 0.8 },
};

/**
 * How far each kind of place may pull the route, relative to the style's
 * corridor. A beach is the point of the ride for someone who likes
 * beaches; a boba shop is a stop on the way. Tried with one reach for
 * everything: Marina -> Inner Sunset for "beaches + boba" picked two boba
 * shops and no beach, because Baker and China Beach sit ~2 km off the line.
 */
export const REACH: Record<PlaceInterest, number> = {
  beach: 2,
  viewpoint: 2,
  park: 1.5,
  art: 1,
  boba: 1,
  coffee: 1,
  food: 1,
};

export interface InterestRoute {
  style: RideStyle;
  styleLabel: string;
  route: RouteSummary;
  /** Places the route is sent through, in riding order. */
  stops: Poi[];
  /** Other matching places the route passes within ALONG_METERS of - labelled, not visited. */
  along: Poi[];
  /** How much longer than the plain route without interests. */
  extraPercent: number;
}

const ALL_POIS = (poiFile as { pois: Poi[] }).pois;
/** A place this close to the route is "on the way" and gets labelled. */
export const ALONG_METERS = 100;

function insideSevere(p: LatLng): boolean {
  return SF_DANGEROUS_NEIGHBORHOODS.some((a) => {
    if (areaTier(a.risk) !== "Severe") return false;
    const dy = (p.lat - a.center.lat) * 111_320;
    const dx = (p.lng - a.center.lng) * 111_320 * Math.cos((p.lat * Math.PI) / 180);
    return Math.hypot(dx, dy) <= a.radiusMeters;
  });
}

/**
 * Picks places for one style: round-robin across the chosen categories so
 * each interest is represented, closest-to-the-line first, spaced out along
 * the trip, until the stop count or detour budget runs out.
 */
export function choosePlaces(
  pois: Poi[],
  categories: PlaceInterest[],
  basePath: LatLng[],
  baseMeters: number,
  style: RideStyle,
  opts: {
    /** Detour still available, if part of the budget is already spent. */
    budgetMeters?: number;
    /** Stops already chosen (second pass): keep spacing from them, count them towards the cap. */
    existing?: LatLng[];
  } = {}
): Poi[] {
  const st = STYLE[style];
  const corridor = Math.min(st.corridorMax, st.corridor * baseMeters);
  const minGap = 0.08 * baseMeters;
  const budget = opts.budgetMeters ?? st.budget * baseMeters;
  const existing = (opts.existing ?? []).map((p) => alongPath(p, basePath));
  const maxStops = st.maxStops - existing.length;
  // The length of THIS path - on the second pass it is the reshaped ride,
  // longer than the plain line. Using the plain length here cut off the
  // last third of a beach ride and every boba shop in it.
  let pathMeters = 0;
  for (let i = 1; i < basePath.length; i++) pathMeters += distanceToPath(basePath[i], [basePath[i - 1], basePath[i - 1]]);
  const byCat = new Map<PlaceInterest, { poi: Poi; off: number; along: number }[]>();
  for (const c of categories) byCat.set(c, []);
  for (const poi of pois) {
    const list = byCat.get(poi.category);
    if (!list || insideSevere(poi)) continue;
    const off = distanceToPath(poi, basePath);
    if (off > corridor * REACH[poi.category]) continue;
    const along = alongPath(poi, basePath);
    // Not right at the start or the end - that is where the rider already is.
    if (along < 0.05 * pathMeters || along > 0.95 * pathMeters) continue;
    list.push({ poi, off, along });
  }
  for (const list of byCat.values()) list.sort((a, b) => a.off - b.off);

  const chosen: { poi: Poi; off: number; along: number }[] = [];
  const perCat = new Map<PlaceInterest, number>();
  let detour = 0;
  for (let progress = true; progress && chosen.length < maxStops; ) {
    progress = false;
    for (const c of categories) {
      if (chosen.length >= maxStops || (perCat.get(c) ?? 0) >= st.perCategory) continue;
      const list = byCat.get(c)!;
      const i = list.findIndex(
        (x) =>
          detour + 2 * x.off <= budget &&
          chosen.every((y) => Math.abs(y.along - x.along) >= minGap) &&
          existing.every((a) => Math.abs(a - x.along) >= minGap) &&
          !chosen.some((y) => y.poi.name === x.poi.name) // one branch of a chain is enough
      );
      if (i < 0) continue;
      const [pick] = list.splice(i, 1);
      chosen.push(pick);
      perCat.set(c, (perCat.get(c) ?? 0) + 1);
      detour += 2 * pick.off;
      progress = true;
    }
  }
  return chosen.sort((a, b) => a.along - b.along).map((x) => x.poi);
}

export function planInterestRoutes(
  origin: LatLng,
  destination: LatLng,
  interests: InterestId[],
  options: PlanOptions = {},
  pois: Poi[] = ALL_POIS
): InterestRoute[] {
  const profile = interests.includes("bikepaths") ? "safest" : "balanced";
  const categories = interests.filter((i): i is PlaceInterest => i !== "bikepaths");
  const base = planCustomPath(origin, destination, [], profile, options);
  const baseMeters = base.path.distanceMeters;
  const labels = INTERESTS.filter((i) => interests.includes(i.id)).map((i) => i.label.toLowerCase());

  const out: InterestRoute[] = [];
  // Destinations (a beach, a view, a park) shape the ride; quick stops
  // (boba, coffee, food, art) are then found along THAT ride. In one pass,
  // "beaches + boba" spent the whole budget reaching the beach and then
  // looked for boba near the original line, which the ride no longer used.
  const destinations = categories.filter((c) => REACH[c] > 1);
  const quickStops = categories.filter((c) => REACH[c] <= 1);

  for (const style of ["quick", "relaxed"] as const) {
    const first = choosePlaces(pois, destinations, base.path.path, baseMeters, style);
    let shaped = base.path;
    if (first.length > 0) {
      try {
        shaped = planCustomPath(origin, destination, first, profile, options).path;
      } catch {
        /* fall back to the plain line; the loop below drops unreachable stops */
      }
    }
    const spent = shaped.distanceMeters - baseMeters;
    const second = choosePlaces(pois, quickStops, shaped.path, baseMeters, style, {
      budgetMeters: Math.max(0, STYLE[style].budget * baseMeters - spent),
      existing: first,
    });
    let stops = [...first, ...second].sort((a, b) => alongPath(a, shaped.path) - alongPath(b, shaped.path));
    let route: RouteSummary | null = null;
    // A place can sit where no bike route reaches it; drop it and try again.
    while (!route) {
      try {
        const plan = planCustomPath(origin, destination, stops, profile, options);
        route = summarizeCustom(plan, stops, profile, options);
      } catch (e) {
        if (!(e instanceof RoutingError) || stops.length === 0) throw e;
        stops = stops.slice(0, -1);
      }
    }
    const stopIds = new Set(stops.map((s) => s.id));
    const along = pois
      .filter((p) => categories.includes(p.category) && !stopIds.has(p.id))
      .filter((p) => distanceToPath(p, route!.path) <= ALONG_METERS)
      .slice(0, 40);
    // Same route twice is not a choice.
    if (out.some((o) => Math.abs(o.route.distanceMeters - route!.distanceMeters) < 5)) continue;
    out.push({
      style,
      styleLabel: STYLE[style].label,
      route: {
        ...route,
        label: `${STYLE[style].label} ${labels.join(" + ") || "ride"}`,
        interestStops: stops.map((p) => ({ name: p.name, emoji: emojiFor(p.category) })),
      },
      stops,
      along,
      extraPercent: Math.round((route.distanceMeters / Math.max(1, baseMeters) - 1) * 100),
    });
  }
  return out;
}
