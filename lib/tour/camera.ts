import type { LatLng } from "../types";

/**
 * Camera path maths for the 3D route fly-through.
 *
 * Deliberately pure and renderer-agnostic: nothing here imports MapLibre.
 * The fly-through is currently drawn with MapLibre + free OpenFreeMap
 * tiles because this project's Google key has the Map Tiles API blocked
 * (Photorealistic 3D Tiles answer 403 PERMISSION_DENIED, and
 * `Map3DElement` fails to initialise). If that API is later enabled,
 * swapping the renderer should not mean rewriting the camera work, so the
 * geometry lives here and the renderer only consumes `CameraKeyframe`s.
 */

export interface CameraKeyframe {
  /** Point the camera looks at. */
  center: LatLng;
  /** Compass bearing in degrees the camera faces, 0 = north. */
  bearing: number;
  /** Cumulative distance along the route, in metres. */
  distanceMeters: number;
  /** 0-1 progress along the whole route. */
  t: number;
}

const M_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function segmentMeters(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * metersPerDegLng((a.lat + b.lat) / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Compass bearing from `a` to `b`, 0-360 with 0 = north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * metersPerDegLng((a.lat + b.lat) / 2);
  // atan2(east, north) gives a compass bearing directly, unlike the usual
  // atan2(y, x) which measures from the x-axis counter-clockwise.
  return (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360;
}

/**
 * Shortest signed turn from bearing `from` to `to`, in -180..180.
 *
 * Interpolating bearings naively is the classic compass bug: going from
 * 350 deg to 10 deg linearly sweeps the camera 340 degrees the wrong way
 * round, which on screen is a violent spin at exactly the moment the rider
 * is making a gentle turn through north.
 */
export function shortestTurn(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export function lerpBearing(from: number, to: number, t: number): number {
  return (((from + shortestTurn(from, to) * t) % 360) + 360) % 360;
}

function lerpPoint(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Resamples a route's vertices into evenly-spaced camera keyframes.
 *
 * Route geometry comes straight from the graph, so vertex spacing follows
 * however OSM happened to split each street - a few metres at a complex
 * junction, a few hundred along a straight. Flying the camera vertex to
 * vertex would therefore crawl through intersections and lurch down open
 * roads. Resampling by distance makes the tour move at a constant speed
 * over the ground, which is what "a tour of the route" should feel like.
 */
export function buildCameraPath(path: LatLng[], spacingMeters = 40): CameraKeyframe[] {
  if (path.length < 2) {
    return path.length === 1
      ? [{ center: path[0], bearing: 0, distanceMeters: 0, t: 0 }]
      : [];
  }

  // Cumulative distance at each input vertex.
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + segmentMeters(path[i - 1], path[i]));
  }
  const total = cum[cum.length - 1];
  if (total === 0) {
    return [{ center: path[0], bearing: 0, distanceMeters: 0, t: 0 }];
  }

  const frames: CameraKeyframe[] = [];
  let seg = 0;
  for (let d = 0; d <= total; d += spacingMeters) {
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const spanStart = cum[seg];
    const spanLen = cum[seg + 1] - spanStart;
    const localT = spanLen > 0 ? (d - spanStart) / spanLen : 0;
    frames.push({
      center: lerpPoint(path[seg], path[seg + 1], localT),
      bearing: bearingDegrees(path[seg], path[seg + 1]),
      distanceMeters: d,
      t: d / total,
    });
  }

  // Always finish exactly at the destination rather than wherever the last
  // whole step landed, so the tour ends on the pin and not short of it.
  const last = path[path.length - 1];
  frames.push({
    center: last,
    bearing: bearingDegrees(path[path.length - 2], last),
    distanceMeters: total,
    t: 1,
  });

  return smoothBearings(frames);
}

/**
 * Rolling average over bearings, done through `shortestTurn` so the
 * wrap-around at 360 does not poison the mean.
 *
 * Without this the camera snaps hard at every corner, because each
 * keyframe inherits its segment's exact bearing and city blocks meet at
 * right angles. A short window keeps turns legible while still letting
 * the camera actually follow the street.
 */
function smoothBearings(frames: CameraKeyframe[], window = 3): CameraKeyframe[] {
  if (frames.length <= 2) return frames;
  return frames.map((f, i) => {
    const lo = Math.max(0, i - window);
    const hi = Math.min(frames.length - 1, i + window);
    const base = f.bearing;
    let acc = 0;
    let n = 0;
    for (let j = lo; j <= hi; j++) {
      acc += shortestTurn(base, frames[j].bearing);
      n++;
    }
    return { ...f, bearing: (((base + acc / n) % 360) + 360) % 360 };
  });
}

/**
 * The keyframe at a given progress, with position and bearing interpolated
 * between the two surrounding frames so playback is smooth at any frame
 * rate rather than stepping between samples.
 */
export function sampleCameraPath(frames: CameraKeyframe[], t: number): CameraKeyframe | null {
  if (frames.length === 0) return null;
  const clamped = Math.max(0, Math.min(1, t));
  if (frames.length === 1) return frames[0];

  const exact = clamped * (frames.length - 1);
  const i = Math.min(frames.length - 2, Math.floor(exact));
  const localT = exact - i;
  const a = frames[i];
  const b = frames[i + 1];

  return {
    center: lerpPoint(a.center, b.center, localT),
    bearing: lerpBearing(a.bearing, b.bearing, localT),
    distanceMeters: a.distanceMeters + (b.distanceMeters - a.distanceMeters) * localT,
    t: clamped,
  };
}

/** Bounding box of a path, for framing the whole route before the tour starts. */
export function pathBounds(path: LatLng[]): [[number, number], [number, number]] | null {
  if (path.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of path) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
