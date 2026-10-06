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
