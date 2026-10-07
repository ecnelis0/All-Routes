import type { LatLng } from "../types";

/** Metres from `p` to the nearest point of `path` (local planar approximation). */
export function distanceToPath(p: LatLng, path: LatLng[]): number {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = (path[i].lng - p.lng) * mLng;
    const ay = (path[i].lat - p.lat) * mLat;
    const bx = (path[i + 1].lng - p.lng) * mLng;
    const by = (path[i + 1].lat - p.lat) * mLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Distance along `path` (metres from its start) of the point on it nearest `p`. */
export function alongPath(p: LatLng, path: LatLng[]): number {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  let bestDist = Infinity;
  let bestAlong = 0;
  let walked = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = (path[i].lng - p.lng) * mLng;
    const ay = (path[i].lat - p.lat) * mLat;
    const dx = (path[i + 1].lng - path[i].lng) * mLng;
    const dy = (path[i + 1].lat - path[i].lat) * mLat;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = walked + t * Math.sqrt(len2);
    }
    walked += Math.sqrt(len2);
  }
  return bestAlong;
}

/**
 * Adds a stop where it belongs in the trip. Clicking the map near the
 * middle of the route should make a stop in the middle, not tack one onto
 * the end and send the rider back across town - so stops are ordered by
 * where along the current route they fall.
 */
export function insertWaypoint(waypoints: LatLng[], stop: LatLng, path: LatLng[]): LatLng[] {
  const along = alongPath(stop, path);
  const i = waypoints.findIndex((w) => alongPath(w, path) > along);
  return i < 0 ? [...waypoints, stop] : [...waypoints.slice(0, i), stop, ...waypoints.slice(i)];
}
