/**
 * Exports one feature row per graph edge to CSV for model training.
 *
 * This script imports `extractFeatures` from `lib/scoring/features.ts` -
 * the exact same function the running app calls - rather than
 * reimplementing the feature maths in Python. That is deliberate and it is
 * the single most important property of this file.
 *
 * Train/serve skew (training on features computed one way, serving on
 * features computed subtly differently) is the classic silent ML failure:
 * offline metrics look great, production quality is mysteriously poor, and
 * nothing errors. Keeping exactly one implementation of the feature maths
 * makes that class of bug impossible rather than merely unlikely.
 *
 * Run: npm run ml:export-features
 * Out: ml/data/edge_features.csv
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_MOCK_CRASHES } from "../lib/mockData";
import { REAL_SF_HIGHWAYS } from "../lib/dataSources/sfHighways";
import {
  FEATURE_ORDER,
  FEATURE_SET_VERSION,
  buildFeatureContext,
  extractFeatures,
} from "../lib/scoring/features";
import { decodeGraph } from "../lib/routing/graph";
import rawGraph from "../lib/data/sfBikeGraph.json";

const here = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const graph = decodeGraph(rawGraph as Parameters<typeof decodeGraph>[0]);
  const ctx = buildFeatureContext(ALL_MOCK_CRASHES, REAL_SF_HIGHWAYS, graph.nodes);

  // Identifying columns first, then the feature vector in FEATURE_ORDER.
  // `edge_id` is what a precomputed score table is keyed by, and
  // `graph_generated_at` is recorded in the artifact so a score table built
  // against a stale graph refuses to load (edge ids are positional).
  const header = [
    "edge_id",
    "from_node",
    "to_node",
    "street_name",
    "road_class",
    "lane_tier",
    "length_meters",
    "mid_lat",
    "mid_lng",
    ...FEATURE_ORDER,
  ];

  const rows: string[] = [header.join(",")];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  for (const edge of graph.edges) {
    const f = extractFeatures(edge, ctx);
    const a = graph.nodes[edge.from];
    const b = graph.nodes[edge.to];
    rows.push(
      [
        edge.id,
        edge.from,
        edge.to,
        esc(edge.name),
        edge.roadClass,
        edge.tier,
        edge.lengthMeters,
        ((a.lat + b.lat) / 2).toFixed(6),
        ((a.lng + b.lng) / 2).toFixed(6),
        ...FEATURE_ORDER.map((k) => {
          const v = f[k];
          return Number.isInteger(v) ? v : Number(v.toFixed(6));
        }),
      ].join(",")
    );
  }

  const outDir = path.join(here, "..", "ml", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "edge_features.csv");
  writeFileSync(outPath, rows.join("\n") + "\n");

  // Side-car metadata so train.py never has to guess, and so a retrain
  // against a regenerated graph is detectable.
  const metaPath = path.join(outDir, "feature_meta.json");
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        featureSetVersion: FEATURE_SET_VERSION,
        featureOrder: FEATURE_ORDER,
        edgeCount: graph.edges.length,
        graphGeneratedAt: graph.generatedAt,
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  process.stdout.write(
    `Wrote ${outPath}\n  ${graph.edges.length} edges x ${FEATURE_ORDER.length} features\n` +
      `Wrote ${metaPath}\n  feature set v${FEATURE_SET_VERSION}, graph ${graph.generatedAt}\n`
  );
}

main();
