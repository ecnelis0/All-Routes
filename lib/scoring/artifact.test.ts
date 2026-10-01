import { describe, expect, it } from "vitest";
import { loadModelArtifact, ModelArtifactError } from "./artifact";
import { FEATURE_ORDER, FEATURE_SET_VERSION } from "./features";
import { LinearSafetyModel, PrecomputedScoreModel } from "./model";

const GRAPH_AT = "2026-01-01T00:00:00Z";

function precomputed(overrides: Record<string, unknown> = {}) {
  return {
    kind: "precomputed",
    version: "test",
    trainedAt: GRAPH_AT,
    featureSetVersion: FEATURE_SET_VERSION,
    featureOrder: [...FEATURE_ORDER],
    scores: [10, 20, 30],
    edgeCount: 3,
    graphGeneratedAt: GRAPH_AT,
    ...overrides,
  };
}

function linear(overrides: Record<string, unknown> = {}) {
  return {
    kind: "linear",
    version: "test",
    trainedAt: GRAPH_AT,
    featureSetVersion: FEATURE_SET_VERSION,
    featureOrder: [...FEATURE_ORDER],
    coefficients: FEATURE_ORDER.map(() => 1),
    intercept: 0,
    ...overrides,
  };
}

const OPTS = { graphEdgeCount: 3, graphGeneratedAt: GRAPH_AT };

describe("loadModelArtifact", () => {
  it("loads a valid precomputed artifact", () => {
    expect(loadModelArtifact(precomputed(), OPTS)).toBeInstanceOf(PrecomputedScoreModel);
  });

  it("loads a valid linear artifact", () => {
    expect(loadModelArtifact(linear(), OPTS)).toBeInstanceOf(LinearSafetyModel);
  });

  // Each case below is a way a stale artifact can produce confidently wrong
  // routes while looking fine. They must throw, not fall back - a silent
  // fallback means nobody ever learns the trained model stopped being used.
  it("rejects a model trained on a different feature set version", () => {
    expect(() => loadModelArtifact(precomputed({ featureSetVersion: 99 }), OPTS)).toThrow(
      ModelArtifactError
    );
  });

  it("rejects a reordered feature vector", () => {
    // Same feature names, different positions - coefficients are positional,
    // so this would silently map every weight to the wrong feature.
    const reversed = [...FEATURE_ORDER].reverse();
    expect(() => loadModelArtifact(linear({ featureOrder: reversed }), OPTS)).toThrow(
      /feature order does not match/i
    );
  });

  it("rejects a renamed feature", () => {
    const renamed: string[] = [...FEATURE_ORDER];
    renamed[0] = "someOtherFeature";
    expect(() => loadModelArtifact(linear({ featureOrder: renamed }), OPTS)).toThrow(
      /feature order does not match/i
    );
  });

  it("rejects a score table sized for a different graph", () => {
    expect(() => loadModelArtifact(precomputed({ scores: [1, 2] }), OPTS)).toThrow(
      /different graph/i
    );
  });

  it("rejects scores trained against an older graph generation", () => {
    // Edge ids are positional, so a regenerated graph silently renumbers
    // every street. Same edge count, completely different meaning.
    expect(() =>
      loadModelArtifact(precomputed({ graphGeneratedAt: "2025-06-06T00:00:00Z" }), OPTS)
    ).toThrow(/different streets/i);
  });

  it("rejects an unknown artifact kind", () => {
    expect(() => loadModelArtifact(precomputed({ kind: "transformer" }), OPTS)).toThrow(
      /unknown model artifact kind/i
    );
  });

  it("rejects a precomputed artifact with no scores", () => {
    const a = precomputed();
    delete (a as Record<string, unknown>).scores;
    expect(() => loadModelArtifact(a, OPTS)).toThrow(/missing "scores"/);
  });

  it("rejects a linear artifact with no coefficients", () => {
    const a = linear();
    delete (a as Record<string, unknown>).coefficients;
    expect(() => loadModelArtifact(a, OPTS)).toThrow(/missing "coefficients"/);
  });

  it("rejects a non-object artifact", () => {
    expect(() => loadModelArtifact(null, OPTS)).toThrow(ModelArtifactError);
  });
});

describe("PrecomputedScoreModel", () => {
  it("falls back to the baseline for an edge id the table does not cover", () => {
    const model = loadModelArtifact(precomputed(), OPTS) as PrecomputedScoreModel;
    const features = {
      crashDensity: 0,
      severeCrashDensity: 0,
      laneProtection: 1,
      isCycleway: 0,
      freewayProximity: 0,
      arterialProximity: 0,
      speedNormalized: 0,
      roadClassRisk: 0,
      neighborhoodRisk: 0,
      lengthKm: 0.1,
    };
    // id 2 is in the table; id 99 is past the end and must not read as 0
    // (a missing score silently meaning "perfectly safe" is the dangerous
    // failure here - the router would route straight onto it).
    expect(model.scoreByEdgeId(2, features)).toBe(30);
    expect(model.scoreByEdgeId(99, features)).toBeGreaterThan(0);
  });
});
