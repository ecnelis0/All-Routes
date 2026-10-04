/**
 * Samples real ground elevation at every node of the bike graph.
 *
 * Source: AWS Terrain Tiles (Mapzen "terrarium" encoding), which over the
 * US is built from USGS 1/3 arc-second NED - roughly 10m resolution, fine
 * enough to resolve a single steep block. Verified independently against
 * known summits before this was wired in: Twin Peaks 250m, Nob Hill 101m,
 * Ferry Building 2.1m, Ocean Beach 9.1m.
 *
 * Why per-node elevation rather than a list of steep streets: a name is
 * the wrong unit for grade. 24th Street is one of the steepest climbs in
 * the city through Noe Valley and dead flat through the Mission, where it
 * is a major bike corridor; Broadway is a wall on Russian Hill and level
 * downtown. Penalising either by name would push riders off exactly the
 * flat stretches they should be on. Elevation at each node gives the
 * grade of every individual block.
 *
 * Run: npm run data:fetch-elevation
 * Out: lib/data/sfNodeElevation.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const Z = 14;
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const UA = "no-roll-models/0.1 (bike safety routing; dev data fetch)";

function lngToTileX(lng, z) {
  return ((lng + 180) / 360) * 2 ** z;
}
function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(x, y, attempt = 0) {
  try {
    const res = await fetch(TILE_URL(Z, x, y), { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    if (attempt >= 3) throw e;
    await sleep(1000 * (attempt + 1));
    return fetchTile(x, y, attempt + 1);
  }
}

/** Terrarium: elevation = (R*256 + G + B/256) - 32768 metres. */
function decode(png, px, py) {
  const i = (png.width * py + px) * 4;
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
}

async function main() {
  const raw = JSON.parse(readFileSync(path.join(root, "lib", "data", "sfBikeGraph.json"), "utf8"));
  const n = raw.nodeCount;

  const xs = raw.lng.map((lng) => lngToTileX(lng, Z));
  const ys = raw.lat.map((lat) => latToTileY(lat, Z));
  const tiles = new Map();
  for (let i = 0; i < n; i++) {
    // Bilinear sampling can reach one pixel past the tile edge, so register
    // the neighbour tile too when a node sits on the last row/column.
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const tx = Math.floor(xs[i] + dx / 256);
      const ty = Math.floor(ys[i] + dy / 256);
      tiles.set(`${tx},${ty}`, [tx, ty]);
    }
  }

  process.stdout.write(`Fetching ${tiles.size} terrarium tiles at z${Z}...\n`);
  const cache = new Map();
  let done = 0;
  for (const [key, [tx, ty]] of tiles) {
    cache.set(key, await fetchTile(tx, ty));
    done++;
    if (done % 10 === 0 || done === tiles.size) process.stdout.write(`  ${done}/${tiles.size}\r`);
  }
  process.stdout.write("\n");

  // Elevation at an arbitrary global pixel coordinate, crossing tile
  // borders as needed.
  const at = (gx, gy) => {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    const png = cache.get(`${tx},${ty}`);
    if (!png) return NaN;
    return decode(png, Math.min(255, gx - tx * 256), Math.min(255, gy - ty * 256));
  };

  // Decimetres as integers: a full metre of quantisation would flatten the
  // ~1-3m climbs of individual blocks that the grade calculation depends on.
  const elevDm = new Array(n);
  let missing = 0;
  for (let i = 0; i < n; i++) {
    // Bilinear interpolation between the four surrounding DEM pixels. Nearest-
    // pixel sampling makes every node in the same 10m cell share a height,
    // and short edges then read as perfectly flat followed by a cliff.
    const gx = xs[i] * 256 - 0.5;
    const gy = ys[i] * 256 - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const e =
      at(x0, y0) * (1 - fx) * (1 - fy) +
      at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy +
      at(x0 + 1, y0 + 1) * fx * fy;
    if (!Number.isFinite(e)) {
      missing++;
      elevDm[i] = 0;
    } else {
      elevDm[i] = Math.round(e * 10);
    }
  }

  // BRIDGES. The DEM is ground, and over water that means the bay floor:
  // 75 nodes on the Bay Bridge Trail and the Golden Gate Bridge sidewalks
  // sampled down to -98.8m, which a router would read as a plunge into
  // the bay and a 99m climb back out. A bridge deck spans between its two
  // abutments, so any node below sea level is filled from its neighbours
  // (a Laplacian fill), repeated until the fill propagates from the shore
  // along the whole deck. The result is a smooth span from abutment to
  // abutment - not the true deck profile, but no fake cliff either.
  const neighbours = Array.from({ length: n }, () => []);
  for (let k = 0; k < raw.edgeCount; k++) {
    neighbours[raw.from[k]].push(raw.to[k]);
    neighbours[raw.to[k]].push(raw.from[k]);
  }
  const SEA_LEVEL_DM = 0;
  let underwater = [];
  for (let i = 0; i < n; i++) if (elevDm[i] < SEA_LEVEL_DM) underwater.push(i);
  const bridgeNodes = underwater.length;
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (elevDm[i] >= SEA_LEVEL_DM) fixed[i] = 1;
  for (let pass = 0; pass < 500 && underwater.length > 0; pass++) {
    const next = [];
    for (const i of underwater) {
      const known = neighbours[i].filter((j) => fixed[j]);
      if (known.length === 0) {
        next.push(i);
        continue;
      }
      elevDm[i] = Math.round(known.reduce((sum, j) => sum + elevDm[j], 0) / known.length);
      fixed[i] = 1;
    }
    if (next.length === underwater.length) break; // isolated - nothing to fill from
    underwater = next;
  }
  // Anything still unfilled is an island of water-sampled nodes with no
  // shore connection; clamp rather than leave a negative height.
  for (const i of underwater) elevDm[i] = SEA_LEVEL_DM;
  process.stdout.write(`  bridge/pier nodes re-spanned from shore: ${bridgeNodes}\n`);

  const outDir = path.join(root, "lib", "data");
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "sfNodeElevation.json");
  writeFileSync(
    out,
    JSON.stringify({
      format: "node-elevation-v1",
      source: "AWS Terrain Tiles (terrarium), USGS NED 1/3 arc-second",
      zoom: Z,
      generatedAt: new Date().toISOString(),
      // Elevation is per node INDEX, which is positional. Recorded so a
      // regenerated graph refuses to load stale heights against renumbered
      // nodes - the same failure the model artifact guards against.
      graphGeneratedAt: raw.generatedAt,
      nodeCount: n,
      elevDm,
    })
  );

  const sorted = elevDm.filter((v) => v !== 0).sort((a, b) => a - b);
  process.stdout.write(
    `Wrote ${out}\n  ${n} nodes, ${missing} missing\n` +
      `  elevation: min ${(sorted[0] / 10).toFixed(1)}m  median ${(sorted[sorted.length >> 1] / 10).toFixed(1)}m  max ${(sorted[sorted.length - 1] / 10).toFixed(1)}m\n`
  );
}

main().catch((e) => {
  process.stderr.write(`\nFailed: ${e.message}\n`);
  process.exit(1);
});
