/**
 * Minutes to show for a route. Uses the router's estimate (distance,
 * climbing and traffic-light waits - see estimateSeconds in
 * lib/routing/service.ts), which is also what "Fastest" minimises, so the
 * times on screen always agree with which route is called fastest.
 *
 * Kept free of the router import so pages do not bundle the street graph.
 * Routes saved before the estimate existed fall back to distance alone.
 */

/** Must equal CRUISE_MPS in lib/routing/service.ts (a test pins this). */
export const FALLBACK_MPS = 3.6;

export interface TimedRoute {
  distanceMeters: number;
  estimatedSeconds?: number;
}

export function rideSeconds(r: TimedRoute): number {
  return r.estimatedSeconds ?? r.distanceMeters / FALLBACK_MPS;
}

export function rideMinutes(r: TimedRoute): number {
  return Math.max(1, Math.round(rideSeconds(r) / 60));
}
