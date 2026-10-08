import { COVERAGE_BOUNDS } from "./data/coverage";

/**
 * Address search, backed by OpenStreetMap's Nominatim - shared by the
 * address boxes (/api/geocode) and the AI assistant ("go via Ocean Beach").
 *
 * Why not Google: this project's Google key has only the Maps JavaScript
 * API enabled (Places Autocomplete and Geocoding answer REQUEST_DENIED).
 * Nominatim needs no key and resolves against the same OpenStreetMap data
 * the routing graph is built from.
 */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// Nominatim's usage policy: at most one request per second per application.
// A single-process in-memory gate - enough for one server, NOT for several.
let lastRequestAt = 0;
const MIN_INTERVAL_MS = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
}

/**
 * Restricted to exactly the area the routing graph covers: a confident
 * match outside it is worse than no match. (A narrower display box once cut
 * off Ocean Beach, which then resolved to an unrelated company downtown.)
 */
export async function geocode(q: string, limit = 6): Promise<GeocodeHit[]> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const b = COVERAGE_BOUNDS;
  const url =
    `${NOMINATIM}?format=jsonv2&limit=${limit}&addressdetails=0` +
    `&viewbox=${b.west},${b.north},${b.east},${b.south}&bounded=1` +
    `&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      // Nominatim rejects requests without an identifying User-Agent.
      "User-Agent": "no-roll-models/0.1 (safer bike routing; dev)",
      "Accept-Language": "en",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const raw = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return raw.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
}
