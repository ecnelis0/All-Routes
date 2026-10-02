export interface ProtectedSpan {
  tier: "fullyProtected" | "semiProtected";
  name: string | null;
  startMeters: number;
  endMeters: number;
}

export interface AvoidedArea {
  name: string;
  atMeters: number;
  closestMeters: number;
}

export type TourAnnotationKind = "protected" | "avoided";

export interface TourAnnotation {
  kind: TourAnnotationKind;
  /** Short headline, e.g. "Protected bike lane". */
  title: string;
  /** Qualifier, e.g. the street or area name. */
  detail: string;
  /** Distance along the route at which this becomes relevant. */
  atMeters: number;
  /** Distance after which it stops being shown. */
  untilMeters: number;
}

/**
 * How far past its trigger point an annotation stays on screen, in metres
 * of route. Expressed in distance rather than seconds because the tour's
 * playback speed varies with route length - a time-based duration would
 * flash by on a long route and linger on a short one.
 */
const AVOIDED_VISIBLE_METERS = 320;
/** Minimum on-screen distance for a protected lane, so short ones still register. */
const PROTECTED_MIN_VISIBLE_METERS = 180;

const TIER_TITLE: Record<ProtectedSpan["tier"], string> = {
  fullyProtected: "Protected bike lane",
  semiProtected: "Buffered bike lane",
};

/**
 * Builds the ordered list of callouts a tour shows as it plays: the
 * protected infrastructure it uses, and the flagged neighbourhoods it
 * steers around.
 *
 * These are the two claims the whole app rests on, so the tour should say
 * them out loud at the moment they happen rather than leaving the rider
 * to infer them from a statistics panel afterwards.
 */
export function buildAnnotations(
  protectedSpans: ProtectedSpan[],
  avoidedNearby: AvoidedArea[]
): TourAnnotation[] {
  const out: TourAnnotation[] = [];

  for (const sp of protectedSpans) {
    out.push({
      kind: "protected",
      title: TIER_TITLE[sp.tier],
      // Unnamed protected geometry is usually a park path or a separated
      // cycleway with no street name of its own. "(unnamed)" would read
      // like a bug; describing what it is reads like information.
      detail: sp.name ?? "Separated path",
      atMeters: sp.startMeters,
      untilMeters: Math.max(sp.endMeters, sp.startMeters + PROTECTED_MIN_VISIBLE_METERS),
    });
  }

  for (const a of avoidedNearby) {
    out.push({
      kind: "avoided",
      title: "Avoided",
      detail: a.name,
      atMeters: a.atMeters,
      untilMeters: a.atMeters + AVOIDED_VISIBLE_METERS,
    });
  }

  return out.sort((x, y) => x.atMeters - y.atMeters);
}

/**
 * The annotation to display at a given point along the route, or null.
 *
 * When several overlap - common where a protected lane runs past a
 * flagged area - the most recently triggered one wins, so the caption
 * tracks what just happened rather than freezing on whatever started
 * first.
 */
export function activeAnnotation(
  annotations: TourAnnotation[],
  metersDone: number
): TourAnnotation | null {
  let best: TourAnnotation | null = null;
  for (const a of annotations) {
    if (metersDone < a.atMeters || metersDone > a.untilMeters) continue;
    if (!best || a.atMeters > best.atMeters) best = a;
  }
  return best;
}
