/**
 * Fetches places riders might want to pass on a ride - beaches, boba,
 * coffee, food, parks, viewpoints, street art - from OpenStreetMap
 * (Overpass) for the interest-based route planner (lib/interests).
 *
 * OpenStreetMap has names, types and positions but no ratings. Ratings and
 * "is it actually good" are what the planned Google-backed AI step adds;
 * this gives the planner real places to route past today.
 *
 * Run: npm run data:fetch-pois
 * Out: lib/data/sfPois.json
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "lib", "data", "sfPois.json");
const BBOX = "37.70,-122.52,37.835,-122.355"; // San Francisco
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Category -> Overpass selectors. `nwr` = nodes, ways and relations (areas get a centre). */
const CATEGORIES = {
  beach: ['nwr["natural"="beach"]'],
  boba: ['nwr["cuisine"~"bubble_tea"]', 'nwr["shop"="bubble_tea"]'],
  coffee: ['nwr["amenity"="cafe"]["cuisine"~"coffee"]', 'nwr["amenity"="cafe"][!"cuisine"]'],
  food: ['nwr["amenity"="restaurant"]', 'nwr["amenity"="fast_food"]'],
  park: ['nwr["leisure"="park"]["name"]'],
  viewpoint: ['nwr["tourism"="viewpoint"]'],
  art: ['nwr["tourism"="artwork"]'],
};

async function overpass(query) {
  // Public Overpass servers answer 502/504 under load; a few rounds with a
  // growing pause usually gets through.
  for (let round = 0; round < 4; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 5000 * round));
    for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Overpass answers 406 without one.
          "User-Agent": "all-routes-poi-fetch/1.0 (one-time dev script)",
        },
        body: "data=" + encodeURIComponent(query),
        // Node's fetch never times out on its own; a stalled server hung
        // the first run indefinitely.
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return await res.json();
      process.stderr.write(`${endpoint}: ${res.status}\n`);
    } catch (e) {
      process.stderr.write(`${endpoint}: ${e.message}\n`);
    }
    }
  }
  throw new Error("Every Overpass endpoint failed.");
}

async function main() {
  const pois = [];
  const seen = new Set();
  for (const [category, selectors] of Object.entries(CATEGORIES)) {
    const body = selectors.map((s) => `${s}(${BBOX});`).join("");
    const json = await overpass(`[out:json][timeout:90];(${body});out center tags;`);
    let kept = 0;
    for (const el of json.elements) {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      const name = el.tags?.name;
      // Unnamed places cannot be labelled on a route, so are not useful here.
      if (lat == null || lng == null || !name) continue;
      const key = `${category}:${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pois.push({
        id: `${el.type}/${el.id}`,
        category,
        name,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
      });
      kept++;
    }
    process.stdout.write(`${category}: ${kept}\n`);
    await new Promise((r) => setTimeout(r, 1500)); // be polite to the public server
  }
  writeFileSync(
    OUT,
    JSON.stringify({ source: "OpenStreetMap via Overpass (ODbL)", fetchedAt: new Date().toISOString(), count: pois.length, pois })
  );
  process.stdout.write(`Wrote ${OUT} (${pois.length} places)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
