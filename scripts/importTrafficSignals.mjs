/**
 * Imports SFMTA's traffic signal inventory (DataSF "Traffic Signals") into
 * a compact file the router can use for the "fewer traffic lights" option.
 *
 * Source CSV: data/raw/sf_traffic_signals.csv (1,507 rows as exported).
 *
 * Not every row stops a cyclist, and counting the ones that do not would
 * penalise routes for nothing. The inventory mixes in pedestrian
 * rectangular flashing beacons (RRFB), radar speed signs, message signs,
 * flashers, and signals that are pending or planned and do not exist yet.
 * Kept:
 *   SIGNAL           - an operating city signal (1,290), including the
 *                      one marked contractor-maintained
 *   CALTRANS         - a state-operated signal on a city street (12), and
 *                      the two maintained by a contractor consortium
 *   CALTRANS - HAWK  - a pedestrian hybrid beacon; it does stop traffic
 *                      when activated (9)
 *
 * Run: npm run data:import-signals
 * Out: lib/data/sfTrafficSignals.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const SRC = path.join(root, "data", "raw", "sf_traffic_signals.csv");
const OUT = path.join(root, "lib", "data", "sfTrafficSignals.json");

const STOPPING_TYPES = new Set([
  "SIGNAL",
  "SIGNAL (CONTRACTOR MAINTAINED)",
  "CALTRANS",
  "CALTRANS (BY CONTRACTOR CONSORTIUM GLC)",
  "CALTRANS - HAWK",
]);

/** Minimal RFC 4180 parser: quoted fields, embedded commas and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1);
}

function main() {
  const [header, ...body] = parseCsv(readFileSync(SRC, "utf8"));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const signals = [];
  const skipped = {};
  for (const r of body) {
    const type = r[col.TYPE];
    if (!STOPPING_TYPES.has(type)) {
      skipped[type || "(blank)"] = (skipped[type || "(blank)"] ?? 0) + 1;
      continue;
    }
    const m = /POINT \((-?[\d.]+) (-?[\d.]+)\)/.exec(r[col.shape] ?? "");
    if (!m) continue;
    signals.push({
      lat: Math.round(Number(m[2]) * 1e6) / 1e6,
      lng: Math.round(Number(m[1]) * 1e6) / 1e6,
      type,
      streets: [r[col.STREET1], r[col.STREET2]].filter(Boolean).join(" & "),
    });
  }
  writeFileSync(
    OUT,
    JSON.stringify({
      source: "SFMTA Traffic Signals inventory, DataSF (exported 2026-10-03)",
      importedAt: new Date().toISOString(),
      count: signals.length,
      signals,
    })
  );
  process.stdout.write(
    `Wrote ${OUT}\n  kept ${signals.length} stopping signals\n  skipped: ${JSON.stringify(skipped)}\n`
  );
}

main();
