import { FEATURE_ORDER, FEATURE_SET_VERSION } from "./features";
import {
  LinearSafetyModel,
  PrecomputedScoreModel,
  createBaselineModel,
  type SafetyModel,
} from "./model";

/**
 * The on-disk contract for a trained model. `ml/train.py` writes exactly
 * this; `loadModelArtifact` below is the only thing that reads it.
 *
 * Every field exists to catch a specific way a stale artifact can silently
 * produce wrong routes:
 *  - `featureSetVersion` / `featureOrder`: the model was trained on a
 *    different feature vector than the app now builds. Positional
 *    coefficients would still "work" and be completely wrong.
 *  - `edgeCount` / `graphGeneratedAt`: precomputed scores are keyed by edge
 *    id, and edge ids are positional. Re-running the graph fetch reshuffles
 *    them, so scores from before the refetch describe different streets.
 */
export interface ModelArtifact {
  kind: "linear" | "precomputed";
  version: string;
  trainedAt: string;
  featureSetVersion: number;
  featureOrder: string[];
  /** Free-form metrics from the training run, surfaced for debugging. */
  metrics?: Record<string, number>;
  /** kind === "linear" */
  coefficients?: number[];
  intercept?: number;
  /** kind === "precomputed" */
  scores?: number[];
  edgeCount?: number;
  graphGeneratedAt?: string;
}

export class ModelArtifactError extends Error {}

/**
 * Validates and instantiates a trained model, or throws with a message
 * saying exactly what to re-run.
 *
 * This deliberately throws rather than falling back to the baseline on a
 * mismatch. A silent fallback is the worst option available: the app keeps
 * working, routes get quietly worse, and nothing in the logs says the
 * trained model you just spent a week on is not actually being used.
 * Absence of an artifact is fine and falls back (see `getSafetyModel`);
 * a *broken* artifact is a bug and should be loud.
 */
export function loadModelArtifact(
  raw: unknown,
  opts: { graphEdgeCount?: number; graphGeneratedAt?: string } = {}
): SafetyModel {
  if (typeof raw !== "object" || raw === null) {
    throw new ModelArtifactError("Model artifact is not an object.");
  }
  const a = raw as ModelArtifact;

  if (a.featureSetVersion !== FEATURE_SET_VERSION) {
    throw new ModelArtifactError(
      `Model was trained on feature set v${a.featureSetVersion} but this build uses ` +
        `v${FEATURE_SET_VERSION}. Re-export training data and retrain ` +
        `(npm run ml:export-features && python ml/train.py).`
    );
  }

  const expected = FEATURE_ORDER.join(",");
  const got = (a.featureOrder ?? []).join(",");
  if (got !== expected) {
    throw new ModelArtifactError(
      `Model feature order does not match this build.\n  expected: ${expected}\n  got:      ${got}\n` +
        `Retrain against the current lib/scoring/features.ts.`
    );
  }

  if (a.kind === "linear") {
    if (!Array.isArray(a.coefficients)) {
      throw new ModelArtifactError('Linear artifact is missing "coefficients".');
    }
    return new LinearSafetyModel(a.version, a.coefficients, a.intercept ?? 0);
  }

  if (a.kind === "precomputed") {
    if (!Array.isArray(a.scores)) {
      throw new ModelArtifactError('Precomputed artifact is missing "scores".');
    }
    // Edge ids are positions in the graph's edge array, so a score table
    // built against a different graph is not merely stale - it describes
    // the wrong streets entirely.
    if (opts.graphEdgeCount != null && a.scores.length !== opts.graphEdgeCount) {
      throw new ModelArtifactError(
        `Score table has ${a.scores.length} entries but the graph has ${opts.graphEdgeCount} ` +
          `edges. These scores were computed against a different graph - re-run ` +
          `scripts/fetchSfBikeGraph.mjs and retrain, or restore the matching graph.`
      );
    }
    if (
      opts.graphGeneratedAt != null &&
      a.graphGeneratedAt != null &&
      a.graphGeneratedAt !== opts.graphGeneratedAt
    ) {
      throw new ModelArtifactError(
        `Score table was built against a graph generated at ${a.graphGeneratedAt}, but the ` +
          `loaded graph was generated at ${opts.graphGeneratedAt}. Edge ids are positional, ` +
          `so these scores describe different streets. Retrain.`
      );
    }
    return new PrecomputedScoreModel(
      a.version,
      Float32Array.from(a.scores),
      createBaselineModel()
    );
  }

  throw new ModelArtifactError(`Unknown model artifact kind "${a.kind}".`);
}
