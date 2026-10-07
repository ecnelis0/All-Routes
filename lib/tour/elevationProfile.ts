import type { LatLng } from "../types";
import { cumulativeDistances } from "./traffic";

/**
 * Elevation along a route, for the live readout in the 3D tour: where the
 * rider is, how steep it is right here, and how much has been climbed and
 * dropped so far.
 *
 * Built from the same per-vertex elevations the router summarised, so the
 * "climbed so far" figure ends the tour exactly on the route's total
 * elevation gain shown in the sidebar.
 */

export interface ElevationProfile {
  /** Distance along the route at each vertex, metres. */
  cum: number[];
  elev: number[];
  /** Climbed / dropped from the start up to each vertex, metres. */
  gainTo: number[];
  lossTo: number[];
  totalMeters: number;
  minElev: number;
  maxElev: number;
}

export interface ElevationSample {
  elevation: number;
  /** Grade right here, percent; positive = uphill. */
  gradePercent: number;
  gained: number;
  dropped: number;
}

/** Grade is measured over this much road either side, not across one vertex. */
const GRADE_WINDOW_METERS = 20;

export function buildElevationProfile(path: LatLng[], elevations: number[]): ElevationProfile | null {
  if (path.length < 2 || elevations.length !== path.length) return null;
  const cum = cumulativeDistances(path);
  const gainTo = [0];
  const lossTo = [0];
  let lo = elevations[0];
  let hi = elevations[0];
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    gainTo.push(gainTo[i - 1] + Math.max(0, d));
    lossTo.push(lossTo[i - 1] + Math.max(0, -d));
    lo = Math.min(lo, elevations[i]);
    hi = Math.max(hi, elevations[i]);
  }
  return { cum, elev: elevations, gainTo, lossTo, totalMeters: cum[cum.length - 1], minElev: lo, maxElev: hi };
}

/** Index of the segment containing `meters`, and how far along it (0-1). */
function locate(p: ElevationProfile, meters: number): [number, number] {
  const m = Math.max(0, Math.min(p.totalMeters, meters));
  let lo = 0;
  let hi = p.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= m) lo = mid;
    else hi = mid;
  }
  const span = p.cum[hi] - p.cum[lo];
  return [lo, span > 0 ? (m - p.cum[lo]) / span : 0];
}

export function elevationAt(p: ElevationProfile, meters: number): number {
  const [i, t] = locate(p, meters);
  const j = Math.min(i + 1, p.elev.length - 1);
  return p.elev[i] + (p.elev[j] - p.elev[i]) * t;
}

export function sampleElevation(p: ElevationProfile, meters: number): ElevationSample {
  const [i, t] = locate(p, meters);
  const j = Math.min(i + 1, p.elev.length - 1);
  const d = p.elev[j] - p.elev[i];
  const a = Math.max(0, meters - GRADE_WINDOW_METERS);
  const b = Math.min(p.totalMeters, meters + GRADE_WINDOW_METERS);
  return {
    elevation: elevationAt(p, meters),
    gradePercent: b > a ? ((elevationAt(p, b) - elevationAt(p, a)) / (b - a)) * 100 : 0,
    // Partway along a segment, count the part of its climb already ridden.
    gained: p.gainTo[i] + Math.max(0, d) * t,
    dropped: p.lossTo[i] + Math.max(0, -d) * t,
  };
}
