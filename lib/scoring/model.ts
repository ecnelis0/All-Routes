import {
  FEATURE_ORDER,
  FEATURE_SET_VERSION,
  featuresToVector,
  type EdgeFeatures,
} from "./features";

/**
 * THE MODEL SEAM.
 *
 * Everything downstream of this interface - the router, the cost function,
 * the map colouring - depends only on "give me a 0-100 danger score for
 * this edge." Nothing downstream knows or cares whether that number came
 * from hand-tuned weights, a linear regression, or a gradient-boosted tree.
 *
 * That is the whole point: training a real model should be a matter of
 * dropping a new artifact into `lib/data/model/` and changing nothing else.
 *
 * Scores are 0-100, higher = more dangerous, and MUST be comparable across
 * edges - the router sums them along a path, so a model that only gets the
 * *ranking* right but not the spacing will produce strange routes.
 */
export interface SafetyModel {
  readonly name: string;
  readonly version: string;
  /** 0-100, higher = more dangerous. */
  score(features: EdgeFeatures): number;
}

const clamp100 = (x: number) => Math.max(0, Math.min(100, x));

/**
 * A plain linear model: `score = sigmoid-free dot product of features and
 * coefficients, plus intercept, clamped to 0-100`.
 *
 * This is the format `ml/train.py` exports by default, and it is
 * deliberately the dullest thing that could work. A linear model on
 * well-chosen features is interpretable (you can read off exactly why a
 * street scored badly, which matters a great deal when the output is
 * telling a cyclist where to ride), trains on far less data than anything
 * fancier, and is trivially portable across the Python/TypeScript boundary
 * as a list of numbers. Swap in a tree ensemble later via
 * `PrecomputedScoreModel` if the linear fit proves too blunt.
 */
export class LinearSafetyModel implements SafetyModel {
  readonly name = "linear";

  constructor(
    readonly version: string,
    private coefficients: number[],
    private intercept: number
  ) {
    if (coefficients.length !== FEATURE_ORDER.length) {
      throw new Error(
        `Linear model expects ${FEATURE_ORDER.length} coefficients (one per feature in ` +
          `FEATURE_ORDER), got ${coefficients.length}.`
      );
    }
  }

  score(features: EdgeFeatures): number {
    const v = featuresToVector(features);
    let sum = this.intercept;
    for (let i = 0; i < v.length; i++) sum += v[i] * this.coefficients[i];
    return clamp100(sum);
  }
}

/**
 * A lookup table of per-edge scores produced offline.
 *
 * This is the path chosen for this project: train whatever you like in
 * Python - a gradient-boosted tree, a neural net, something with features
 * this codebase never sees - then export one score per edge id. Runtime
 * inference becomes an array index, so model complexity costs nothing at
 * request time, and the browser/server never needs an ML runtime.
 *
 * The trade-off, and it is a real one: scores are frozen per edge, so
 * anything that varies per request (time of day, weather, rider profile)
 * cannot be expressed. If that becomes a requirement, this is the class to
 * replace - the `SafetyModel` interface above stays the same.
 */
export class PrecomputedScoreModel implements SafetyModel {
  readonly name = "precomputed";

  constructor(
    readonly version: string,
    private scores: Float32Array,
    /** Used when an edge id has no score - a graph newer than the artifact. */
    private fallback: SafetyModel
  ) {}

  scoreByEdgeId(edgeId: number, features: EdgeFeatures): number {
    const s = this.scores[edgeId];
    return Number.isFinite(s) && s >= 0 ? clamp100(s) : this.fallback.score(features);
  }

  score(features: EdgeFeatures): number {
    // Reached only when the caller has no edge id (e.g. scoring an
    // arbitrary map point rather than a graph edge).
    return this.fallback.score(features);
  }
}

/**
 * The hand-tuned baseline, used until a trained artifact exists.
 *
 * These weights are the same judgement calls the original `lib/danger.ts`
 * made (crash history dominates, infrastructure and highway exposure split
 * the rest), re-expressed against the richer feature set. They are a
 * starting point and a fallback, NOT a target for the trained model to
 * reproduce - if training disagrees with these numbers, training is
 * probably right.
 *
 * Why these specific values: each coefficient is "how many points of 0-100
 * danger does one unit of this feature add." `laneProtection` running 0->1
 * (protected lane -> nothing at all) adding 30 points, for instance, mirrors
 * the 0.3 infrastructure weight the original model used.
 */
export const BASELINE_COEFFICIENTS: Record<keyof EdgeFeatures, number> = {
  crashDensity: 1.6,
  severeCrashDensity: 2.4,
  laneProtection: 30,
  isCycleway: -12,
  freewayProximity: 22,
  arterialProximity: 14,
  speedNormalized: 8,
  roadClassRisk: 18,
  lengthKm: 0,
};

export function createBaselineModel(): LinearSafetyModel {
  return new LinearSafetyModel(
    `baseline-f${FEATURE_SET_VERSION}`,
    FEATURE_ORDER.map((k) => BASELINE_COEFFICIENTS[k]),
    4
  );
}
