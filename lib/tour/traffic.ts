import type { LatLng } from "../types";
import { bearingDegrees, segmentMeters } from "./camera";

/**
 * Illustrative car traffic along the route's own roadway.
 *
 * HONESTY NOTE, which matters more here than anywhere else in the app.
 * San Francisco does not publish a city-wide average-daily-traffic
 * dataset - DataSF has bike counts and parking censuses, but no per-street
 * vehicle volumes - so there is no real number to drive this from. What
 * IS real is the road classification the vehicles are placed on: OSM
 * road class and posted speed, the same attributes the safety model
 * scores. Density and speed below are derived from those.
 *
 * So: the roads are real, the busyness ordering is real, the individual
 * cars are not. The UI labels this "illustrative" for that reason, and it
 * must keep doing so. If a real volume feed is ever wired in, replace
 * `densityFor` and delete this paragraph.
 */

export type TrafficRoadClass =
  | "primary"
  | "secondary"
  | "tertiary"
  | "residential"
  | "service"
  | "cycleway"
  | "path"
  | "livingStreet";

/** Vehicles per kilometre per direction, by road class. */
const DENSITY_PER_KM: Record<TrafficRoadClass, number> = {
  primary: 26,
  secondary: 18,
  tertiary: 11,
  residential: 5,
  service: 2,
  livingStreet: 2,
  // Cars do not drive on these, and drawing them there would be a lie
  // about the very infrastructure the app is recommending.
  cycleway: 0,
  path: 0,
};

/** Typical flowing speed in m/s, by road class. */
const SPEED_MPS: Record<TrafficRoadClass, number> = {
  primary: 11,
  secondary: 9,
  tertiary: 7.5,
  residential: 5.5,
  service: 3,
  livingStreet: 3,
  cycleway: 0,
  path: 0,
};

export interface TrafficVehicle {
  /** Stable id so rendering can key on it. */
  id: number;
  /** Distance along the route, metres. Negative/over-length wraps. */
  offsetMeters: number;
  /** +1 travels with the rider, -1 oncoming. */
  direction: 1 | -1;
  speedMps: number;
}

export interface TrafficSpan {
  startMeters: number;
  endMeters: number;
  roadClass: TrafficRoadClass;
}

export function densityFor(roadClass: TrafficRoadClass): number {
  return DENSITY_PER_KM[roadClass] ?? 0;
}

/**
 * Lays out vehicles along the route once, deterministically.
 *
 * Seeded rather than random so the same route always produces the same
 * traffic: a tour that looks different every replay reads as noise, and
 * makes screenshots impossible to compare.
 */
export function layOutTraffic(spans: TrafficSpan[], seed = 1): TrafficVehicle[] {
  const out: TrafficVehicle[] = [];
  let rnd = seed >>> 0;
  // xorshift32 - small, fast, and reproducible across machines, which
  // Math.random is not.
  const next = () => {
    rnd ^= rnd << 13;
    rnd ^= rnd >>> 17;
    rnd ^= rnd << 5;
    return ((rnd >>> 0) % 10000) / 10000;
  };

  let id = 0;
  for (const span of spans) {
    const lengthKm = (span.endMeters - span.startMeters) / 1000;
    if (lengthKm <= 0) continue;
    const perDirection = Math.round(densityFor(span.roadClass) * lengthKm);
    if (perDirection <= 0) continue;

    const base = SPEED_MPS[span.roadClass] ?? 0;
    for (const direction of [1, -1] as const) {
      for (let i = 0; i < perDirection; i++) {
        out.push({
          id: id++,
          offsetMeters: span.startMeters + next() * (span.endMeters - span.startMeters),
          direction,
          // +/-20% so vehicles do not move as a rigid block.
          speedMps: base * (0.8 + next() * 0.4),
        });
      }
    }
  }
  return out;
}

/**
 * Positions vehicles at a point in time, as GeoJSON ready for a symbol
 * layer. Each vehicle carries its heading so the icon can face the way it
 * is travelling.
 *
 * `windowMeters` keeps only vehicles near the camera: a cross-town route
 * at primary-road density is thousands of cars, and rendering the ones
 * five kilometres behind the rider costs frames for nothing.
 */
export function trafficAt(
  vehicles: TrafficVehicle[],
  path: LatLng[],
  cumulative: number[],
  elapsedSeconds: number,
  riderMeters: number,
  windowMeters = 450
): GeoJSON.FeatureCollection {
  const total = cumulative[cumulative.length - 1] ?? 0;
  const features: GeoJSON.Feature[] = [];
  if (total <= 0) return { type: "FeatureCollection", features };

  for (const v of vehicles) {
    let d = v.offsetMeters + v.direction * v.speedMps * elapsedSeconds;
    // Wrap so traffic is continuous rather than draining off the ends.
    d = ((d % total) + total) % total;
    if (Math.abs(d - riderMeters) > windowMeters) continue;

    const pos = pointAt(path, cumulative, d);
    if (!pos) continue;
    const ahead = pointAt(path, cumulative, Math.min(total, d + 8));
    const heading = ahead ? bearingDegrees(pos, ahead) : 0;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
      properties: {
        id: v.id,
        // Oncoming vehicles face the other way.
        bearing: v.direction === 1 ? heading : (heading + 180) % 360,
        oncoming: v.direction === -1 ? 1 : 0,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Cumulative distance at each path vertex - precompute once per route. */
export function cumulativeDistances(path: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + segmentMeters(path[i - 1], path[i]));
  return cum;
}

/** Interpolated position at a distance along the path. */
export function pointAt(path: LatLng[], cumulative: number[], meters: number): LatLng | null {
  if (path.length === 0) return null;
  if (path.length === 1) return path[0];
  const total = cumulative[cumulative.length - 1];
  const d = Math.max(0, Math.min(total, meters));

  // Binary search: called once per visible vehicle per frame, so a linear
  // scan over a few thousand vertices would dominate the frame budget.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = cumulative[hi] - cumulative[lo];
  const t = span > 0 ? (d - cumulative[lo]) / span : 0;
  return {
    lat: path[lo].lat + (path[hi].lat - path[lo].lat) * t,
    lng: path[lo].lng + (path[hi].lng - path[lo].lng) * t,
  };
}
