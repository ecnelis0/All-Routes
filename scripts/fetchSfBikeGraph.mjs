// One-time data-generation script: pulls the full *bike-routable* street
// network for San Francisco from OpenStreetMap (Overpass API) and writes a
// node/edge graph that `lib/routing/` can actually route on.
//
// Why this exists alongside `fetchSfRoads.mjs`: that script produces
// *display* geometry - major named roads, merged into long smooth chains
// for rendering, with residential streets deliberately excluded to keep the
// map readable. Those chains are useless for routing: merging ways destroys
// the intersection nodes, and a bike router without residential streets is
// a bike router that can't leave the arterials. This script keeps the
// opposite trade-off - every routable way, split at every shared node, with
// OSM node ids preserved so edges actually connect into a graph.
//
// Scope: ways bikes may legally and plausibly ride. Motorways/trunks are
// excluded outright (bikes are banned, and routing onto one is the exact
// failure this whole app exists to prevent); they still matter as a
// *proximity* risk input, which is what `fetchSfRoads.mjs` already covers.
//
// Re-run manually: `node scripts/fetchSfBikeGraph.mjs`
// Output: lib/data/sfBikeGraph.json

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BOUNDS = { north: 37.812, south: 37.705, east: -122.355, west: -122.515 };

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Way classes a bicycle may ride. Ordered roughly best-to-worst for cycling;
// the value is the `roadClass` feature the safety model consumes, NOT a
// score - scoring lives in lib/scoring, so retraining never means editing
// this file.
const ROUTABLE_HIGHWAY = {
  cycleway: "cycleway",
  living_street: "livingStreet",
  residential: "residential",
  unclassified: "residential",
  tertiary: "tertiary",
  tertiary_link: "tertiary",
  secondary: "secondary",
  secondary_link: "secondary",
  primary: "primary",
  primary_link: "primary",
  path: "path",
  footway: "path",
  pedestrian: "path",
  track: "path",
  service: "service",
};

// Bikes are banned on these no matter what else the tags say.
const BANNED_HIGHWAY = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);

// Roads that are a *hazard to ride near* even though (or precisely because)
// you cannot ride on them. These feed the `freewayProximity` and
// `arterialProximity` features, not the routable graph.
//
// Previously this risk came from seven hand-drawn mock shapes
// (MOCK_HIGHWAY_SEGMENTS), which meant the overwhelming majority of San
// Francisco's real arterials - Bayshore, James Lick, Junipero Serra,
// Octavia, Bryant, 19th Ave and ~170 others - contributed exactly zero
// highway-exposure risk. A route could hug the Central Freeway for a mile
// and the model would not notice.
const EXPOSURE_CLASS = {
  motorway: "freeway",
  motorway_link: "freeway",
  trunk: "freeway",
  trunk_link: "freeway",
  primary: "arterial",
  primary_link: "arterial",
  secondary: "arterial",
  secondary_link: "arterial",
};

// Typical speeds by class, used to scale exposure risk where OSM has no
// maxspeed tag. Rough, and only a feature input - the model decides how
// much speed actually matters.
const DEFAULT_SPEED_MPH = { freeway: 60, arterial: 35 };

function overpassQuery() {
  const bbox = `${BOUNDS.south},${BOUNDS.west},${BOUNDS.north},${BOUNDS.east}`;
  return `
[out:json][timeout:180];
(
  way["highway"](${bbox});
);
out body geom;
`.trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass() {
  const body = new URLSearchParams({ data: overpassQuery() }).toString();
  let lastErr;
  // Overpass answers 429 when its slots are busy and 504 when a query times
  // out server-side; both are routinely transient, so back off and retry
  // rather than failing the whole run. A missing User-Agent earns a 406.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        process.stdout.write(`Querying ${endpoint} (attempt ${attempt + 1}) ...\n`);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "no-roll-models-bike-graph-fetch/1.0 (one-time dev script)",
            Accept: "application/json",
          },
          body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements?.length) throw new Error("no elements returned");
        return json.elements;
      } catch (err) {
        lastErr = err;
        process.stdout.write(`  failed: ${err.message}\n`);
      }
    }
    const waitMs = 20_000 * (attempt + 1);
    process.stdout.write(`  all endpoints failed; waiting ${waitMs / 1000}s before retry\n`);
    await sleep(waitMs);
  }
  throw new Error(`All Overpass endpoints failed. Last: ${lastErr?.message}`);
}

function haversineMeters(a, b) {
  const R = 6_371_000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Reads OSM cycling-infrastructure tags into the same four-tier vocabulary
 * the rest of the app already speaks (`BikeLaneTier` in lib/types.ts).
 * This is a *feature extractor*, not a judgement about how safe each tier
 * is - that judgement is the model's job and lives in lib/scoring.
 */
function bikeLaneTierFromTags(tags) {
  const t = (k) => (tags[k] ?? "").toLowerCase();

  if (t("highway") === "cycleway") return "fullyProtected";
  // Explicit physical separation.
  const sep = [t("cycleway"), t("cycleway:both"), t("cycleway:left"), t("cycleway:right")];
  if (sep.some((v) => v === "track")) return "fullyProtected";
  if (t("cycleway:both:separation") || t("cycleway:separation")) return "fullyProtected";
  if (sep.some((v) => v === "lane" || v === "opposite_lane")) {
    // A buffered lane is meaningfully better than bare paint.
    const buffered =
      t("cycleway:both:buffer") || t("cycleway:buffer") || t("cycleway:lane") === "exclusive";
    return buffered ? "semiProtected" : "unprotected";
  }
  if (sep.some((v) => v === "shared_lane" || v === "share_busway")) return "unprotected";
  return "none";
}

function isOneway(tags) {
  const ow = (tags.oneway ?? "").toLowerCase();
  // `oneway:bicycle=no` is the common tag for "cars one way, bikes both" -
  // contraflow lanes are everywhere in SF and ignoring them would make the
  // router detour around perfectly legal blocks.
  if ((tags["oneway:bicycle"] ?? "").toLowerCase() === "no") return false;
  return ow === "yes" || ow === "true" || ow === "1";
}

// Overpass is a free, shared, donation-funded service. Re-running this
// script while iterating on the *encoding* below should not mean re-asking
// them for the same 40MB of ways, so the raw response is cached off to one
// side and reused unless `--refresh` is passed.
const RAW_CACHE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".cache",
  "sf-overpass-raw.json"
);

async function loadElements() {
  const refresh = process.argv.includes("--refresh");
  if (!refresh && existsSync(RAW_CACHE)) {
    process.stdout.write(`Reusing cached Overpass response (${RAW_CACHE}).\n`);
    process.stdout.write(`Pass --refresh to re-query.\n`);
    return JSON.parse(readFileSync(RAW_CACHE, "utf8"));
  }
  const elements = await fetchOverpass();
  mkdirSync(path.dirname(RAW_CACHE), { recursive: true });
  writeFileSync(RAW_CACHE, JSON.stringify(elements));
  return elements;
}

function main() {
  return loadElements().then((elements) => {
    const nodes = new Map(); // osm node id -> {id, lat, lng}
    const edges = [];
    let skippedBanned = 0;
    let skippedUnroutable = 0;

    const exposureRoads = [];

    for (const el of elements) {
      if (el.type !== "way" || !el.geometry || !el.nodes) continue;
      const tags = el.tags ?? {};
      const hw = (tags.highway ?? "").toLowerCase();

      // Record proximity hazards before the routability filters below drop
      // them - freeways in particular are *excluded from the graph* yet are
      // the single biggest exposure risk, so they must be captured here or
      // they are lost entirely.
      const exposure = EXPOSURE_CLASS[hw];
      if (exposure) {
        const mph =
          parseInt((tags.maxspeed ?? "").replace(/[^0-9]/g, ""), 10) ||
          DEFAULT_SPEED_MPH[exposure];
        exposureRoads.push({
          id: `osm-${el.id}`,
          name: tags.name ?? (exposure === "freeway" ? "Unnamed freeway" : "Unnamed arterial"),
          type: exposure,
          typicalSpeedMph: mph,
          path: el.geometry.map((g) => ({
            lat: Math.round(g.lat * 1e6) / 1e6,
            lng: Math.round(g.lon * 1e6) / 1e6,
          })),
        });
      }

      if (BANNED_HIGHWAY.has(hw)) {
        skippedBanned++;
        continue;
      }
      const roadClass = ROUTABLE_HIGHWAY[hw];
      if (!roadClass) {
        skippedUnroutable++;
        continue;
      }
      // Respect explicit bike bans on otherwise-routable ways.
      if ((tags.bicycle ?? "").toLowerCase() === "no") {
        skippedUnroutable++;
        continue;
      }
      // Footways/pedestrian areas only count if bikes are actually allowed.
      if ((hw === "footway" || hw === "pedestrian") && (tags.bicycle ?? "").toLowerCase() !== "yes") {
        skippedUnroutable++;
        continue;
      }

      const tier = bikeLaneTierFromTags(tags);
      const oneway = isOneway(tags);
      const name = tags.name ?? null;
      const maxspeed = parseInt((tags.maxspeed ?? "").replace(/[^0-9]/g, ""), 10) || null;

      // Split the way at every OSM node: those shared nodes ARE the
      // intersections, and keeping them is the whole point of this file.
      for (let i = 0; i < el.nodes.length - 1; i++) {
        const aId = el.nodes[i];
        const bId = el.nodes[i + 1];
        const aGeom = el.geometry[i];
        const bGeom = el.geometry[i + 1];
        if (!aGeom || !bGeom) continue;

        if (!nodes.has(aId)) nodes.set(aId, { id: aId, lat: aGeom.lat, lng: aGeom.lon });
        if (!nodes.has(bId)) nodes.set(bId, { id: bId, lat: bGeom.lat, lng: bGeom.lon });

        const length = haversineMeters(
          { lat: aGeom.lat, lng: aGeom.lon },
          { lat: bGeom.lat, lng: bGeom.lon }
        );
        if (length <= 0) continue;

        edges.push({
          from: aId,
          to: bId,
          wayId: el.id,
          name,
          roadClass,
          tier,
          oneway,
          maxspeed,
          lengthMeters: Math.round(length * 10) / 10,
        });
      }
    }

    // Drop nodes no surviving edge references (cheap, keeps the file honest).
    const used = new Set();
    for (const e of edges) {
      used.add(e.from);
      used.add(e.to);
    }
    const nodeList = [...nodes.values()].filter((n) => used.has(n.id));

    const here = path.dirname(fileURLToPath(import.meta.url));
    const outDir = path.join(here, "..", "lib", "data");
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "sfBikeGraph.json");

    // Compact columnar encoding. The obvious `[{from, to, roadClass, ...}]`
    // shape repeats ~120 bytes of JSON *key names* on every one of 128k
    // edges, which costs ~26MB on disk and a slow parse on every cold
    // start. Columnar arrays of small ints cut that by roughly 5x, and
    // `lib/routing/graph.ts` decodes it back into objects once at load.
    // Node ids are re-indexed to dense 0..n-1 integers (OSM ids are 10-digit
    // numbers); coordinates are fixed to 6dp, which is ~0.1m - far finer
    // than the geometry's own accuracy.
    const nodeIndex = new Map();
    nodeList.forEach((n, i) => nodeIndex.set(n.id, i));

    const roadClasses = [...new Set(edges.map((e) => e.roadClass))];
    const tiers = [...new Set(edges.map((e) => e.tier))];
    const names = [...new Set(edges.map((e) => e.name).filter(Boolean))];
    const nameIndex = new Map(names.map((n, i) => [n, i]));
    const r6 = (x) => Math.round(x * 1e6) / 1e6;

    const payload = {
      format: "columnar-v1",
      generatedAt: new Date().toISOString(),
      source: "OpenStreetMap contributors (ODbL), via Overpass API",
      bounds: BOUNDS,
      // Lookup tables for the small-int columns below.
      roadClasses,
      tiers,
      names,
      nodeCount: nodeList.length,
      edgeCount: edges.length,
      lat: nodeList.map((n) => r6(n.lat)),
      lng: nodeList.map((n) => r6(n.lng)),
      from: edges.map((e) => nodeIndex.get(e.from)),
      to: edges.map((e) => nodeIndex.get(e.to)),
      roadClass: edges.map((e) => roadClasses.indexOf(e.roadClass)),
      tier: edges.map((e) => tiers.indexOf(e.tier)),
      // -1 = unnamed, so the column stays a plain int array.
      name: edges.map((e) => (e.name == null ? -1 : nameIndex.get(e.name))),
      oneway: edges.map((e) => (e.oneway ? 1 : 0)),
      maxspeed: edges.map((e) => e.maxspeed ?? 0),
      lengthMeters: edges.map((e) => Math.round(e.lengthMeters * 10) / 10),
    };
    writeFileSync(outPath, JSON.stringify(payload));

    const hwPath = path.join(outDir, "sfHighways.json");
    writeFileSync(
      hwPath,
      JSON.stringify({
        generatedAt: payload.generatedAt,
        source: payload.source,
        segments: exposureRoads,
      })
    );
    const expCounts = {};
    for (const r of exposureRoads) expCounts[r.type] = (expCounts[r.type] ?? 0) + 1;
    process.stdout.write(
      `Wrote ${hwPath}\n  exposure roads: ${JSON.stringify(expCounts)}\n`
    );

    const tierCounts = {};
    for (const e of edges) tierCounts[e.tier] = (tierCounts[e.tier] ?? 0) + 1;
    const classCounts = {};
    for (const e of edges) classCounts[e.roadClass] = (classCounts[e.roadClass] ?? 0) + 1;

    process.stdout.write(
      `\nWrote ${outPath}\n` +
        `  nodes: ${nodeList.length}\n` +
        `  edges: ${edges.length}\n` +
        `  skipped (bikes banned): ${skippedBanned}\n` +
        `  skipped (not routable): ${skippedUnroutable}\n` +
        `  by tier:  ${JSON.stringify(tierCounts)}\n` +
        `  by class: ${JSON.stringify(classCounts)}\n`
    );
  });
}

main().catch((err) => {
  process.stderr.write(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
