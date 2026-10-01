import type { GraphEdge } from "./graph";

/**
 * How strongly a route profile trades distance for safety.
 *
 * The cost of an edge is `lengthMeters * (1 + safetyWeight * score/100)`,
 * so `safetyWeight` reads directly as "how many times longer a detour I
 * will accept to avoid a maximally dangerous street." At 2.0, a street
 * scoring 100 costs 3x its length, so the router will go up to 3x as far
 * around it; a street scoring 50 costs 2x.
 *
 * This multiplicative-on-length form is deliberate. An additive penalty
 * ("+50 per bad edge") makes the cost depend on how finely the graph
 * happens to be split, so a street chopped into ten OSM ways would be
 * penalised ten times for the same hazard. Scaling by length makes the
 * score mean "danger per metre ridden," which is both the honest
 * interpretation and invariant to how OSM segmented the street.
 */
export interface RouteProfile {
  id: "fastest" | "balanced" | "safest";
  label: string;
  safetyWeight: number;
  /**
   * Edges scoring at or above this are refused outright rather than merely
   * made expensive. This is what makes "never route me onto that" a
   * guarantee instead of a preference - with a weight alone, a sufficiently
   * large detour always eventually loses to a short dangerous shortcut.
   */
  hardAvoidScore: number;
}

export const ROUTE_PROFILES: Record<RouteProfile["id"], RouteProfile> = {
  // Still bike-legal (the graph excludes motorways entirely) but indifferent
  // to danger - this is the baseline the other two are compared against,
  // and roughly what a conventional routing app returns.
  fastest: { id: "fastest", label: "Fastest", safetyWeight: 0, hardAvoidScore: Infinity },
  balanced: { id: "balanced", label: "Safer", safetyWeight: 1.5, hardAvoidScore: 92 },
  safest: { id: "safest", label: "Safest", safetyWeight: 5, hardAvoidScore: 75 },
};

/**
 * Per-edge cost in "effective metres". `scoreOf` returns the model's 0-100
 * danger score for an edge; returning `Infinity` means impassable for this
 * profile.
 */
export function edgeCost(
  edge: GraphEdge,
  score: number,
  profile: RouteProfile
): number {
  if (score >= profile.hardAvoidScore) return Infinity;
  return edge.lengthMeters * (1 + profile.safetyWeight * (score / 100));
}
