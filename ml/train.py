"""
Train the street-safety model and export an artifact the app can load.

This is the only file you should need to touch to train. The app does not
import it, does not run it, and does not need Python at runtime - training
produces a JSON artifact and that is the entire interface.

    npm run ml:export-features     # build ml/data/edge_features.csv
    python ml/train.py             # train, write lib/data/model/safety-model.json

WHAT YOU STILL NEED TO SUPPLY: labels. Features describe every street;
labels say how dangerous each one actually turned out to be. Without real
labels this script trains against the hand-tuned baseline (see
--target=baseline), which is useful only as a plumbing check - a model
trained to imitate the baseline cannot be better than the baseline.

See ml/README.md for the label formats accepted and how to get real data.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import KFold, cross_val_predict

ROOT = Path(__file__).resolve().parent.parent
FEATURES_CSV = ROOT / "ml" / "data" / "edge_features.csv"
FEATURE_META = ROOT / "ml" / "data" / "feature_meta.json"
LABELS_CSV = ROOT / "ml" / "data" / "labels.csv"
OUT_ARTIFACT = ROOT / "lib" / "data" / "model" / "safety-model.json"

# The baseline's weights are read from feature_meta.json, which the export
# writes straight from lib/scoring/model.ts - one source of truth. (This
# file used to keep a hand-copied duplicate, which went stale the moment
# the TypeScript weights changed.)


def load_meta() -> dict:
    if not FEATURE_META.exists():
        sys.exit(
            f"Missing {FEATURE_META}.\nRun `npm run ml:export-features` first."
        )
    return json.loads(FEATURE_META.read_text())


def load_features(meta: dict) -> pd.DataFrame:
    if not FEATURES_CSV.exists():
        sys.exit(f"Missing {FEATURES_CSV}.\nRun `npm run ml:export-features` first.")
    df = pd.read_csv(FEATURES_CSV)
    missing = [c for c in meta["featureOrder"] if c not in df.columns]
    if missing:
        sys.exit(f"Feature CSV is missing columns {missing}; re-export.")
    if len(df) != meta["edgeCount"]:
        sys.exit(
            f"Feature CSV has {len(df)} rows but meta says {meta['edgeCount']} edges. "
            "Re-export; these were produced from different graphs."
        )
    return df


def synthetic_baseline_target(df: pd.DataFrame, feature_order: list[str], meta: dict) -> np.ndarray:
    """The hand-tuned baseline's own output, as a stand-in label."""
    coefs = meta["baselineCoefficients"]
    y = np.full(len(df), float(meta["baselineIntercept"]), dtype=float)
    for name in feature_order:
        y += df[name].to_numpy(dtype=float) * float(coefs.get(name, 0.0))
    return np.clip(y, 0, 100)


def load_real_labels(df: pd.DataFrame) -> np.ndarray:
    """
    Joins ml/data/labels.csv onto the feature rows by edge_id.

    Expected columns: `edge_id`, `danger` (0-100, higher = worse).

    Edges with no label are dropped rather than imputed. Imputing a safety
    label is actively dangerous: filling unlabelled streets with the mean
    teaches the model that unknown streets are average, and the router will
    then happily send a rider down a street nobody has any data about.
    Better to train on the labelled subset and let the baseline cover the
    rest (which is exactly what PrecomputedScoreModel's fallback does).
    """
    if not LABELS_CSV.exists():
        sys.exit(
            f"Missing {LABELS_CSV}.\n"
            "Supply real labels (see ml/README.md), or run with --target=baseline "
            "to exercise the pipeline without them."
        )
    labels = pd.read_csv(LABELS_CSV)
    for col in ("edge_id", "danger"):
        if col not in labels.columns:
            sys.exit(f"labels.csv must have columns edge_id,danger - missing '{col}'.")
    merged = df[["edge_id"]].merge(labels[["edge_id", "danger"]], on="edge_id", how="left")
    return merged["danger"].to_numpy(dtype=float)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--target",
        choices=["labels", "baseline"],
        default="labels",
        help="'labels' trains on ml/data/labels.csv (what you want). "
        "'baseline' trains on the hand-tuned model's own output - a plumbing "
        "check only; the result cannot beat the baseline it imitates.",
    )
    ap.add_argument(
        "--model",
        choices=["ridge", "gbt"],
        default="gbt",
        help="ridge exports interpretable coefficients; gbt exports a score table.",
    )
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    meta = load_meta()
    feature_order: list[str] = meta["featureOrder"]
    df = load_features(meta)
    X_all = df[feature_order].to_numpy(dtype=float)

    if args.target == "baseline":
        y_all = synthetic_baseline_target(df, feature_order, meta)
        print("WARNING: training against the hand-tuned baseline's own output.")
        print("         This validates the pipeline, not the model. Supply real")
        print("         labels in ml/data/labels.csv for a model worth shipping.\n")
        mask = np.ones(len(df), dtype=bool)
    else:
        y_all = load_real_labels(df)
        mask = ~np.isnan(y_all)
        if mask.sum() == 0:
            sys.exit("No labels joined onto any edge. Check edge_id values in labels.csv.")
        print(f"Labelled edges: {mask.sum()} of {len(df)} ({100 * mask.mean():.1f}%)\n")

    X = X_all[mask]
    y = y_all[mask]

    if args.model == "ridge":
        model = Ridge(alpha=1.0)
    else:
        model = GradientBoostingRegressor(random_state=args.seed)

    # Cross-validated predictions give an honest error estimate; scoring on
    # the training set would just report how well the model memorised.
    n_splits = min(5, max(2, mask.sum() // 2))
    cv = KFold(n_splits=n_splits, shuffle=True, random_state=args.seed)
    y_cv = cross_val_predict(model, X, y, cv=cv)
    metrics = {
        "cv_mae": float(mean_absolute_error(y, y_cv)),
        "cv_r2": float(r2_score(y, y_cv)),
        "n_train": int(mask.sum()),
    }
    print(f"Cross-validated MAE: {metrics['cv_mae']:.2f} danger points")
    print(f"Cross-validated R^2: {metrics['cv_r2']:.3f}\n")

    model.fit(X, y)

    now = datetime.now(timezone.utc).isoformat()
    version = f"{args.model}-{args.target}-{now[:10]}"

    if args.model == "ridge":
        artifact = {
            "kind": "linear",
            "version": version,
            "trainedAt": now,
            "featureSetVersion": meta["featureSetVersion"],
            "featureOrder": feature_order,
            "metrics": metrics,
            "coefficients": [float(c) for c in model.coef_],
            "intercept": float(model.intercept_),
        }
        print("Learned coefficients (danger points per unit of feature):")
        for name, coef in sorted(
            zip(feature_order, model.coef_), key=lambda kv: -abs(kv[1])
        ):
            print(f"  {name:<22} {coef:+8.2f}")
        print(f"  {'(intercept)':<22} {model.intercept_:+8.2f}")
    else:
        # Score every edge, including unlabelled ones - the model generalises
        # from the labelled subset, which is the point of training it.
        scores = np.clip(model.predict(X_all), 0, 100)
        artifact = {
            "kind": "precomputed",
            "version": version,
            "trainedAt": now,
            "featureSetVersion": meta["featureSetVersion"],
            "featureOrder": feature_order,
            "metrics": metrics,
            "scores": [round(float(s), 2) for s in scores],
            "edgeCount": int(meta["edgeCount"]),
            "graphGeneratedAt": meta["graphGeneratedAt"],
        }
        print("Feature importances:")
        for name, imp in sorted(
            zip(feature_order, model.feature_importances_), key=lambda kv: -kv[1]
        ):
            print(f"  {name:<22} {imp:6.3f}")

    OUT_ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    OUT_ARTIFACT.write_text(json.dumps(artifact))
    size_mb = OUT_ARTIFACT.stat().st_size / 1e6
    print(f"\nWrote {OUT_ARTIFACT} ({size_mb:.1f}MB, kind={artifact['kind']})")
    print("Restart the dev server to pick it up.")


if __name__ == "__main__":
    main()
