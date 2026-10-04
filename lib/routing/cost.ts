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
  /**
   * Refuse any edge inside a flagged neighbourhood.
   *
   * Area risk used to be only a feature, worth ~21 danger points for a
   * SEVERE area at the baseline coefficient. Against a 1.5x weight that
   * is easily outweighed by a shorter distance, so "Safer" routinely
   * returned the identical path to "Fastest" and still crossed the
   * Tenderloin. A profile that promises to avoid dangerous areas has to
   * treat them as impassable, not as a mild surcharge.
   */
  avoidFlaggedAreas: boolean;
  /** Multiply the cost of edges with no protected cycling infrastructure. */
  unprotectedPenalty: number;
}

export const ROUTE_PROFILES: Record<RouteProfile["id"], RouteProfile> = {
  // Still bike-legal (the graph excludes motorways entirely) but indifferent
  // to danger - the baseline the other two are compared against, and
  // roughly what a conventional routing app returns.
  fastest: {
    id: "fastest",
    label: "Fastest",
    safetyWeight: 0,
    hardAvoidScore: Infinity,
    avoidFlaggedAreas: false,
    unprotectedPenalty: 1,
  },
  // Avoids flagged neighbourhoods outright.
  balanced: {
    id: "balanced",
    label: "Safest",
    safetyWeight: 2,
    hardAvoidScore: 88,
    avoidFlaggedAreas: true,
    unprotectedPenalty: 1,
  },
  // Same hard avoidance, and actively prefers protected infrastructure.
  safest: {
    id: "safest",
    label: "Safest + bike lanes",
    safetyWeight: 4,
    hardAvoidScore: 80,
    avoidFlaggedAreas: true,
    // Expressed as a penalty on unprotected roads rather than a discount
    // on protected ones: A*'s straight-line heuristic is only admissible
    // while no edge costs less than its true length, so preferences must
    // be penalties, never bonuses.
    unprotectedPenalty: 1.9,
  },
};

/**
 * Per-edge cost in "effective metres". `scoreOf` returns the model's 0-100
 * danger score for an edge; returning `Infinity` means impassable for this
 * profile.
 */
export function edgeCost(
  edge: GraphEdge,
  score: number,
  profile: RouteProfile,
  inFlaggedArea = false,
  /**
   * Extra effective metres for climbing this edge, precomputed per edge by
   * the engine and passed as 0 unless "avoid elevation" is switched on.
   * Additive and never negative, so cost stays >= true length and the A*
   * heuristic remains admissible.
   */
  elevationPenalty = 0
): number {
  if (score >= profile.hardAvoidScore) return Infinity;
  if (profile.avoidFlaggedAreas && inFlaggedArea) return Infinity;

  const protectedTier = edge.tier === "fullyProtected" || edge.tier === "semiProtected";
  const laneFactor = protectedTier ? 1 : profile.unprotectedPenalty;
  return (
    edge.lengthMeters * (1 + profile.safetyWeight * (score / 100)) * laneFactor +
    Math.max(0, elevationPenalty)
  );
}
