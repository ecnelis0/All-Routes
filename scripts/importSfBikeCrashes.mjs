/**
 * Imports real bicycle-involved injury crashes for San Francisco from
 * DataSF "Traffic Crashes Resulting in Injury" (ubvf-ztfx; SFPD reports,
 * TIMS-geocoded). These replace the randomly generated mock crashes the
 * prototype shipped with, which were feeding the router's danger score.
 *
 * Kept: every collision category that involves a bicycle - Vehicle-Bicycle,
 * Bicycle Only, Bicycle-Parked Car (dooring), Bicycle-Pedestrian,
 * Vehicle-Bicycle-Pedestrian, Bicycle-Unknown.
 *
 * Window: 2019 onward. SF's streets changed a lot after 2018 - Market
 * Street went car-free in January 2020 and much of the protected network
 * was built in these years - so older crashes describe streets that no
 * longer exist in that form.
 *
 * Severity, mapped onto CrashRecord's 1-3 scale:
 *   Injury (Complaint of Pain) -> 1
 *   Injury (Other Visible)     -> 2
 *   Injury (Severe), Fatal     -> 3
 *
 * Run: npm run data:import-crashes
 * Out: lib/data/sfBikeCrashes.json
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "lib", "data", "sfBikeCrashes.json");

const ENDPOINT = "https://data.sf.gov/resource/ubvf-ztfx.json";
const FROM_YEAR = 2019;
const PAGE = 5000;

const SEVERITY = {
  "Injury (Complaint of Pain)": 1,
  "Injury (Other Visible)": 2,
  "Injury (Severe)": 3,
  Fatal: 3,
};

async function fetchAll() {
  const where = `dph_col_grp_description like '%Bicycle%' AND accident_year >= '${FROM_YEAR}'`;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const qs = new URLSearchParams({
      $select:
        "unique_id,collision_date,collision_severity,dph_col_grp_description,primary_rd,secondary_rd,tb_latitude,tb_longitude",
      $where: where,
      $order: "unique_id",
      $limit: String(PAGE),
      $offset: String(offset),
    });
    const res = await fetch(`${ENDPOINT}?${qs}`);
    if (!res.ok) throw new Error(`DataSF ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function main() {
  const rows = await fetchAll();
  const crashes = [];
  const skipped = { noLocation: 0, unknownSeverity: 0 };
  for (const r of rows) {
    const lat = Number(r.tb_latitude);
    const lng = Number(r.tb_longitude);
    // Ungeocoded rows come back blank or at 0,0.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1) {
      skipped.noLocation++;
      continue;
    }
    const severity = SEVERITY[r.collision_severity];
    if (!severity) {
      skipped.unknownSeverity++;
      continue;
    }
    crashes.push({
      id: `sf-${r.unique_id}`,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      severity,
      date: (r.collision_date ?? "").slice(0, 10),
      kind: r.dph_col_grp_description,
      where: [r.primary_rd, r.secondary_rd].filter(Boolean).join(" & "),
    });
  }
  writeFileSync(
    OUT,
    JSON.stringify({
      source: "DataSF Traffic Crashes Resulting in Injury (ubvf-ztfx), bicycle-involved",
      fromYear: FROM_YEAR,
      importedAt: new Date().toISOString(),
      count: crashes.length,
      crashes,
    })
  );
  process.stdout.write(
    `Wrote ${OUT}\n  ${crashes.length} crashes (of ${rows.length} rows)\n  skipped: ${JSON.stringify(skipped)}\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
