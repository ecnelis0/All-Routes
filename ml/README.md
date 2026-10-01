# Training the street-safety model

The app ships with a **hand-tuned baseline** and runs fine without any
trained model. Your job is to replace that baseline with something learned
from real data. Nothing in `app/` or `components/` needs to change when you
do — training writes a JSON artifact, the app loads it, and that is the
entire interface.

## The one-minute version

```bash
# 0. one-time setup
uv venv .venv && uv pip install --python .venv/bin/python -r ml/requirements.txt

# 1. build the feature matrix from the street graph
npm run ml:export-features

# 2. train (needs ml/data/labels.csv — see below)
.venv/bin/python ml/train.py --model=gbt

# 3. restart the dev server
npm run dev
```

The app logs which model it loaded. `modelSource: "trained"` means your
artifact is live; `"baseline"` means it fell back.

## What you need to supply: labels

Everything else is built. The missing input is **labels** — for each street
segment, how dangerous it actually is.

Create `ml/data/labels.csv`:

```csv
edge_id,danger
0,12.5
1,88.0
2,41.2
```

- `edge_id` — matches the `edge_id` column in `ml/data/edge_features.csv`
- `danger` — 0–100, higher is worse

**You do not need to label every edge.** Label what you have; the model
generalises to the rest from the features. Unlabelled edges are *dropped*
from training, never imputed — filling them with the mean would teach the
model that unknown streets are average, and the router would then
cheerfully send a rider down a street nobody has data about.

### Where real labels could come from

| Source | What it gives you | Notes |
|---|---|---|
| SF Open Data — Traffic Crashes Resulting in Injury | Geocoded collisions w/ severity | The most defensible label. Snap each crash to the nearest edge, aggregate per edge, normalise to 0–100. |
| TIMS (Berkeley SafeTREC) | SWITRS collision data for CA | Richer than the city feed; needs an account. |
| BikeMaps.org | Rider-reported crashes and near-misses | Already stubbed at `lib/dataSources/bikemaps.ts`. Self-selected sample — biased toward engaged riders. |
| SFMTA high-injury network | Which corridors the city itself flags | Good as a label or as a sanity check on your model's ranking. |
| Rider surveys / your own rides | Perceived safety | Measures something genuinely different from crash counts. Worth keeping separate rather than mixing in. |

A caution worth taking seriously: crash *counts* measure exposure as much
as danger. A busy protected lane may log more incidents than a deserted
arterial simply because more people ride it. If you can get ridership
estimates, a crash **rate** is a much better label than a crash count, and
the difference will show up directly in where the router sends people.

## Choosing a model

```bash
.venv/bin/python ml/train.py --model=ridge   # interpretable coefficients
.venv/bin/python ml/train.py --model=gbt     # precomputed score table (default)
```

**`ridge`** exports nine numbers — one coefficient per feature. You can read
off exactly why a street scored badly, which matters when the output tells
a cyclist where to ride. Start here; a linear model on good features is
hard to beat and impossible to misread.

**`gbt`** exports one score per edge. Model complexity costs nothing at
request time (inference is an array index), and the browser never needs an
ML runtime. The trade-off is that scores are frozen per edge: anything
varying per request — time of day, weather, rider confidence — cannot be
expressed. If you need that, replace `PrecomputedScoreModel` in
`lib/scoring/model.ts`; the `SafetyModel` interface stays the same.

Both print cross-validated MAE and R². Those come from `cross_val_predict`,
not from scoring the training set, so they are an honest estimate rather
than a measure of how well the model memorised.

## Checking the pipeline without labels

```bash
.venv/bin/python ml/train.py --target=baseline --model=ridge
```

This trains against the hand-tuned baseline's *own output*. It is a plumbing
check only — a model trained to imitate the baseline cannot beat the
baseline. What it proves is that feature export, training, artifact writing
and artifact loading all agree: you should see the learned coefficients come
back close to the baseline's (≈30 for `laneProtection`, ≈22 for
`freewayProximity`) and R² near 1.

## The feature contract

`lib/scoring/features.ts` defines `EdgeFeatures` and `FEATURE_ORDER`. That
file is the single shared contract between runtime scoring, the training
export, and the artifact.

Training and serving compute features with **the same code** —
`scripts/exportTrainingFeatures.ts` imports `extractFeatures` from the app
rather than reimplementing it in Python. That is deliberate: train/serve
skew is the classic silent ML failure, where offline metrics look great and
production is quietly worse with nothing erroring. One implementation makes
that impossible rather than merely unlikely.

### Adding a feature

1. Add the field to `EdgeFeatures`
2. Compute it in `extractFeatures`
3. Add it to `FEATURE_ORDER`
4. **Bump `FEATURE_SET_VERSION`**
5. Add a baseline coefficient in `lib/scoring/model.ts` *and*
   `BASELINE_COEFFICIENTS` in `train.py`
6. Re-export and retrain

Step 4 is what makes a stale artifact refuse to load instead of silently
mis-mapping every coefficient by one position. The loader also rejects
artifacts whose score table was built against a different graph — edge ids
are positional, so regenerating the graph renumbers every street and old
scores would describe the wrong roads. These checks **throw rather than
falling back**, because a silent fallback means nobody ever learns the
trained model stopped being used.

## How the score reaches a route

```
OSM  →  sfBikeGraph.json  →  EdgeFeatures  →  SafetyModel  →  score 0-100
                                                                   ↓
                              A*  ←  edgeCost = length x (1 + w x score/100)
```

`lib/routing/cost.ts` defines three profiles. `safetyWeight` reads as "how
many times longer a detour I will accept to avoid a maximally dangerous
street." `hardAvoidScore` is a hard ceiling — edges at or above it are
refused outright, which is what makes "never route me there" a guarantee
rather than a preference that a long enough detour can outvote.

If you retrain and routes get strange, check the **score distribution**
first. The cost function assumes scores are comparable across edges and
roughly spread over 0–100. A model that gets the ranking right but
compresses everything into 40–60 will produce routes that barely differ
between profiles; one that saturates at 100 will trip the hard-avoid
ceilings everywhere and disconnect the graph. This exact bug cost us a
debugging session: crash density was accidentally divided by edge length,
which pushed 5.7% of edges to a clamped 100 and silently dropped every
profile into best-effort fallback.
