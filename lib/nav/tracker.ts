import type { LatLng } from "../types";
import { bearingDegrees, shortestTurn } from "../tour/camera";
import type { Maneuver } from "./instructions";

/**
 * Matches live GPS fixes to the route being navigated.
 *
 * Naive nearest-point matching fails in exactly the places a city route
 * lives. A route can pass near itself (out along one street, back along
 * the parallel one ~100m away), and phone GPS in a downtown canyon is off
 * by 15-40m. Snapping to the globally nearest point teleports the rider
 * kilometres forward or back along the route.
 *
 * So matching is constrained by history: candidates are searched in a
 * window around where the rider was last matched, biased forward, and -
 * when the rider is actually moving - segments facing the wrong way are
 * penalised using the GPS heading.
 */

export interface GpsFix {
  lat: number;
  lng: number;
  /** Horizontal accuracy radius in metres, as reported by the device. */
  accuracy: number;
  /** Direction of travel in degrees, or null when the device cannot tell. */
  heading: number | null;
  /** Ground speed in m/s, or null. */
  speed: number | null;
  timestamp: number;
}

export interface TrackerState {
  /** Distance along the route of the last good match, metres. */
  alongMeters: number;
  /**
   * Furthest believable progress so far. Instructions are driven by this,
   * not by `alongMeters`: at a corner, GPS noise projects one fix onto the
   * next street and the following fix back again, and announcing from the
   * raw match flips the banner between two turns every second.
   */
  furthestMeters: number;
  /** Consecutive fixes that were too far from the route. */
  offRouteStreak: number;
  /** True once the rider has been off the route long enough to reroute. */
  offRoute: boolean;
  arrived: boolean;
}

export interface MatchResult {
  state: TrackerState;
  /** Fix projected onto the route. */
  snapped: LatLng;
  distanceFromRoute: number;
  /** Bearing of the route segment the rider is on. */
  routeBearing: number;
  next: Maneuver | null;
  metersToNext: number;
  metersRemaining: number;
}

export function initialState(): TrackerState {
  return {
    alongMeters: 0,
    furthestMeters: 0,
    offRouteStreak: 0,
    offRoute: false,
    arrived: false,
  };
}

/** How far behind the last match a new match may land (GPS jitter, brief stops). */
const BACK_WINDOW_METERS = 60;
/**
 * How far ahead a new match may land. At 8 m/s (fast cycling) with a fix
 * every second this is ~50s of riding - generous enough to survive a
 * dropped signal in a tunnel, small enough not to jump to a later pass.
 */
const FORWARD_WINDOW_METERS = 400;
/** Off-route when farther than this from the route, or 1.5x the GPS accuracy if larger. */
const OFF_ROUTE_METERS = 35;
/** Consecutive bad fixes before rerouting - one wild fix should not reroute. */
const OFF_ROUTE_STREAK = 3;
const ARRIVE_WITHIN_METERS = 25;
/** Below this speed the device heading is noise and is ignored. */
const HEADING_MIN_SPEED = 1.5;

export function matchFix(
  fix: GpsFix,
  path: LatLng[],
  cum: number[],
  maneuvers: Maneuver[],
  prev: TrackerState,
  /** Internal: search the whole route, ignoring the history window. */
  fullSearch = false,
): MatchResult {
  const total = cum[cum.length - 1] ?? 0;
  const lo = fullSearch
    ? -Infinity
    : Math.max(0, prev.alongMeters - BACK_WINDOW_METERS);
  const hi = fullSearch ? Infinity : prev.alongMeters + FORWARD_WINDOW_METERS;

  const mPerLng = 111_320 * Math.cos((fix.lat * Math.PI) / 180);
  let best: {
    score: number;
    dist: number;
    along: number;
    pt: LatLng;
    seg: number;
  } | null = null;

  const useHeading =
    fix.heading !== null && (fix.speed ?? 0) >= HEADING_MIN_SPEED;

  for (let i = 0; i < path.length - 1; i++) {
    if (cum[i + 1] < lo || cum[i] > hi) continue;
    const a = path[i];
    const b = path[i + 1];
    // Local planar projection - accurate to centimetres at segment scale.
    const bx = (b.lng - a.lng) * mPerLng;
    const by = (b.lat - a.lat) * 111_320;
    const px = (fix.lng - a.lng) * mPerLng;
    const py = (fix.lat - a.lat) * 111_320;
    const len2 = bx * bx + by * by;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const dx = px - t * bx;
    const dy = py - t * by;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const along = cum[i] + t * (cum[i + 1] - cum[i]);

    let score = dist;
    if (useHeading) {
      const segBearing = bearingDegrees(a, b);
      // A rider facing against the segment is very unlikely to be on it.
      if (Math.abs(shortestTurn(segBearing, fix.heading!)) > 100) score += 40;
    }
    // Mild preference for staying close to the previous match, which
    // settles ties between two near-equidistant candidates the right way.
    score += Math.abs(along - prev.alongMeters) * 0.02;

    if (!best || score < best.score) {
      best = {
        score,
        dist,
        along,
        pt: {
          lat: a.lat + (b.lat - a.lat) * t,
          lng: a.lng + (b.lng - a.lng) * t,
        },
        seg: i,
      };
    }
  }

  // Nothing inside the window (e.g. GPS reappeared after a long gap): retry
  // once over the whole route rather than declaring the rider lost. An
  // earlier draft retried with alongMeters reset to 0, which is still a
  // 400m window - a fix far from the start recursed forever.
  if (!best) {
    if (fullSearch || path.length < 2) {
      return {
        state: { ...prev, offRouteStreak: prev.offRouteStreak + 1 },
        snapped: path[0] ?? { lat: fix.lat, lng: fix.lng },
        distanceFromRoute: Infinity,
        routeBearing: 0,
        next: null,
        metersToNext: 0,
        metersRemaining: total,
      };
    }
    return matchFix(fix, path, cum, maneuvers, prev, true);
  }

  const threshold = Math.max(OFF_ROUTE_METERS, fix.accuracy * 1.5);
  // The window found something, but not close enough: the rider may be
  // further along than the window reaches (GPS dropped out for a while).
  // Search the whole route and accept it only if that match is believable;
  // otherwise this really is an off-route fix.
  if (!fullSearch && best.dist > threshold) {
    const wide = matchFix(fix, path, cum, maneuvers, prev, true);
    if (wide.distanceFromRoute <= threshold) return wide;
  }
  const tooFar = best.dist > threshold;
  const offRouteStreak = tooFar ? prev.offRouteStreak + 1 : 0;
  // Only advance progress on a believable fix; a wild one keeps the old
  // position instead of dragging the rider along the route.
  const alongMeters = tooFar
    ? prev.alongMeters
    : fullSearch
      ? best.along
      : Math.max(prev.alongMeters - BACK_WINDOW_METERS, best.along);
  const furthestMeters = Math.max(prev.furthestMeters, alongMeters);
  const arrived =
    prev.arrived || (!tooFar && total - furthestMeters <= ARRIVE_WITHIN_METERS);

  const next = maneuvers.find((m) => m.atMeters > furthestMeters + 5) ?? null;
  const seg = best.seg;
  return {
    state: {
      alongMeters,
      furthestMeters,
      offRouteStreak,
      offRoute: offRouteStreak >= OFF_ROUTE_STREAK,
      arrived,
    },
    snapped: best.pt,
    distanceFromRoute: best.dist,
    routeBearing: bearingDegrees(path[seg], path[seg + 1]),
    next,
    metersToNext: next ? next.atMeters - furthestMeters : 0,
    metersRemaining: Math.max(0, total - furthestMeters),
  };
}
