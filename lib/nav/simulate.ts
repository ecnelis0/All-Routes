import type { LatLng } from "../types";
import { bearingDegrees } from "../tour/camera";
import type { GpsFix } from "./tracker";

/**
 * Synthetic GPS for riding a route on a desktop.
 *
 * Navigation can only really be exercised by moving, and a laptop does not
 * move. The simulator produces the same `GpsFix` shape the browser's
 * geolocation API does, so everything downstream (matching, instructions,
 * rerouting, arrival) runs exactly as it would on a phone - only the
 * source of positions differs.
 */

/** Typical urban cycling speed including stops, m/s (~10 mph). */
export const CRUISE_SPEED_MPS = 4.5;

const M_PER_DEG_LAT = 111_320;

/** Position and direction of travel at a distance along the route. */
export function pointAlong(
  path: LatLng[],
  cum: number[],
  meters: number,
): { point: LatLng; bearing: number } {
  const last = path.length - 1;
  if (meters <= 0 || last < 1)
    return {
      point: path[0],
      bearing: last >= 1 ? bearingDegrees(path[0], path[1]) : 0,
    };
  if (meters >= cum[last])
    return {
      point: path[last],
      bearing: bearingDegrees(path[last - 1], path[last]),
    };
  let lo = 0;
  let hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= meters) lo = mid;
    else hi = mid;
  }
  const t = (meters - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
  return {
    point: {
      lat: path[lo].lat + (path[hi].lat - path[lo].lat) * t,
      lng: path[lo].lng + (path[hi].lng - path[lo].lng) * t,
    },
    bearing: bearingDegrees(path[lo], path[hi]),
  };
}

/**
 * A fix at `meters` along the route, optionally pushed sideways (positive =
 * to the rider's right) to imitate leaving the route.
 */
export function simulatedFix(
  path: LatLng[],
  cum: number[],
  meters: number,
  opts: { lateralMeters?: number; timestamp?: number; speed?: number } = {},
): GpsFix {
  const { point, bearing } = pointAlong(path, cum, meters);
  const lateral = opts.lateralMeters ?? 0;
  const right = ((bearing + 90) * Math.PI) / 180;
  const mPerLng = M_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
  return {
    lat: point.lat + (Math.cos(right) * lateral) / M_PER_DEG_LAT,
    lng: point.lng + (Math.sin(right) * lateral) / mPerLng,
    accuracy: 5,
    heading: bearing,
    speed: opts.speed ?? CRUISE_SPEED_MPS,
    timestamp: opts.timestamp ?? Date.now(),
  };
}

/** "12 min" / "1 h 5 min" at cruising speed. */
export function formatEta(meters: number, speed = CRUISE_SPEED_MPS): string {
  const min = Math.max(1, Math.round(meters / speed / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * The part of the route still ahead of `meters`, starting exactly at the
 * rider. Drawing only this is how the line visibly "eats" itself as you
 * ride, rather than leaving the whole route painted behind you.
 */
export function pathFrom(
  path: LatLng[],
  cum: number[],
  meters: number,
): LatLng[] {
  if (meters <= 0) return path;
  const { point } = pointAlong(path, cum, meters);
  const i = cum.findIndex((c) => c > meters);
  if (i < 0) return [path[path.length - 1], path[path.length - 1]];
  return [point, ...path.slice(i)];
}
