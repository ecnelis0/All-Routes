import type { LatLng } from "../types";
import { bearingDegrees, shortestTurn } from "../tour/camera";

/**
 * Turn-by-turn instructions from a computed route.
 *
 * A maneuver is emitted where the street name changes, classified by the
 * change in heading across that point. Heading is measured over ~30m on
 * each side rather than across the single vertex at the junction: OSM
 * geometry wiggles at intersections (curb cuts, crosswalk nodes), and a
 * vertex-to-vertex bearing there can swing 60 degrees on a street that
 * actually runs straight through.
 *
 * Unnamed stretches (park paths, alleys, connectors) do not generate
 * their own "turn onto (unnamed)" instruction; the next named street's
 * instruction absorbs them, which is what a rider needs.
 */

export type ManeuverType =
  | "depart"
  | "straight"
  | "slight-left"
  | "left"
  | "sharp-left"
  | "slight-right"
  | "right"
  | "sharp-right"
  | "u-turn"
  | "arrive";

export interface Maneuver {
  type: ManeuverType;
  /** Street the rider is on AFTER this maneuver. */
  street: string | null;
  /** Distance along the route at which the maneuver happens, metres. */
  atMeters: number;
  location: LatLng;
  /** Human-readable instruction, e.g. "Turn left onto Valencia Street". */
  text: string;
}

export interface StreetSpanLike {
  name: string;
  startMeters: number;
  endMeters: number;
}

/** Heading change thresholds, in degrees of turn (positive = right). */
export function classifyTurn(turn: number): ManeuverType {
  const a = Math.abs(turn);
  if (a < 20) return "straight";
  if (a >= 165) return "u-turn";
  const right = turn > 0;
  if (a < 45) return right ? "slight-right" : "slight-left";
  if (a < 135) return right ? "right" : "left";
  return right ? "sharp-right" : "sharp-left";
}

const VERB: Record<ManeuverType, string> = {
  depart: "Head",
  straight: "Continue onto",
  "slight-left": "Bear left onto",
  left: "Turn left onto",
  "sharp-left": "Turn sharp left onto",
  "slight-right": "Bear right onto",
  right: "Turn right onto",
  "sharp-right": "Turn sharp right onto",
  "u-turn": "Make a U-turn onto",
  arrive: "Arrive at your destination",
};

const COMPASS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];
function compass(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/** Cumulative distance at each path vertex. */
export function cumulative(path: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dLat = (b.lat - a.lat) * 111_320;
    const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
    out.push(out[i - 1] + Math.sqrt(dLat * dLat + dLng * dLng));
  }
  return out;
}

function pointAtDistance(path: LatLng[], cum: number[], d: number): LatLng {
  if (d <= 0) return path[0];
  const total = cum[cum.length - 1];
  if (d >= total) return path[path.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const t = (d - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
  return {
    lat: path[lo].lat + (path[hi].lat - path[lo].lat) * t,
    lng: path[lo].lng + (path[hi].lng - path[lo].lng) * t,
  };
}

/** Heading over a window either side of a point, robust to junction wiggle. */
const HEADING_WINDOW_METERS = 30;
/** Street spans shorter than this are junction slivers, not streets to announce. */
const MIN_SPAN_METERS = 20;

export function buildManeuvers(
  path: LatLng[],
  streetSpans: StreetSpanLike[],
): Maneuver[] {
  if (path.length < 2) return [];
  const cum = cumulative(path);
  const total = cum[cum.length - 1];
  const heading = (from: number, to: number) =>
    bearingDegrees(
      pointAtDistance(path, cum, from),
      pointAtDistance(path, cum, to),
    );

  const out: Maneuver[] = [];
  const first =
    streetSpans.find((sp) => sp.endMeters - sp.startMeters >= MIN_SPAN_METERS)
      ?.name ??
    streetSpans[0]?.name ??
    null;
  const startHeading = heading(0, Math.min(total, HEADING_WINDOW_METERS));
  out.push({
    type: "depart",
    street: first,
    atMeters: 0,
    location: path[0],
    text: `Head ${compass(startHeading)}${first ? ` on ${first}` : ""}`,
  });

  // Drop slivers first: a few metres tagged with a cross street's name
  // where two ways meet (Market -> 7m of Duboce -> Market) would otherwise
  // announce "Continue onto Duboce Avenue" and then "Continue onto Market
  // Street" a second later. Then collapse consecutive spans of the same
  // name (a street left and rejoined across an unnamed connector is one
  // street to the rider).
  const solid = streetSpans.filter(
    (sp) => sp.endMeters - sp.startMeters >= MIN_SPAN_METERS,
  );
  const named: StreetSpanLike[] = [];
  for (const sp of solid.length > 0 ? solid : streetSpans) {
    const last = named[named.length - 1];
    if (last && last.name === sp.name) last.endMeters = sp.endMeters;
    else named.push({ ...sp });
  }

  for (let i = 1; i < named.length; i++) {
    const at = named[i].startMeters;
    const before = heading(Math.max(0, at - HEADING_WINDOW_METERS), at);
    const after = heading(at, Math.min(total, at + HEADING_WINDOW_METERS));
    const type = classifyTurn(shortestTurn(before, after));
    out.push({
      type,
      street: named[i].name,
      atMeters: at,
      location: pointAtDistance(path, cum, at),
      text: `${VERB[type]} ${named[i].name}`,
    });
  }

  out.push({
    type: "arrive",
    street: null,
    atMeters: total,
    location: path[path.length - 1],
    text: VERB.arrive,
  });
  return out;
}

/** "Turn left onto Valencia Street in 300 ft" style distance phrasing. */
export function formatDistance(meters: number): string {
  const ft = meters * 3.281;
  if (ft < 100) return "now";
  if (ft < 1000) return `${Math.round(ft / 50) * 50} ft`;
  const mi = meters / 1609.34;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}
