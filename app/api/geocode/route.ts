import { NextResponse } from "next/server";
import { COVERAGE_BOUNDS } from "@/lib/data/coverage";

/**
 * Address search, backed by OpenStreetMap's Nominatim.
 *
 * Why not Google: this project's Google key has only the Maps JavaScript
 * API enabled. Places Autocomplete and Geocoding both answer
 * REQUEST_DENIED, and the legacy Places Autocomplete the app used to call
 * is closed to new Cloud projects entirely (Google, March 2025). Nominatim
 * needs no key, and it resolves against the same OpenStreetMap data the
 * routing graph is built from - so an address that geocodes here is an
 * address the router can actually reach, which is not guaranteed when the
 * geocoder and the graph come from different vendors.
 *
 * If Geocoding API is later enabled on the Cloud project, swapping this
 * implementation out is a single-file change; the response shape below is
 * what the client depends on.
 *
 * Proxied through our own server rather than called from the browser so
 * that the User-Agent and rate limiting Nominatim's usage policy requires
 * are actually under our control.
 */
export const runtime = "nodejs";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// Nominatim's usage policy asks for at most one request per second from an
// application. This is a single-process in-memory gate: it is enough for a
// dev server and a demo, and is NOT sufficient if this ever runs on
// multiple instances - at that point use a shared limiter or a paid
// geocoder.
let lastRequestAt = 0;
const MIN_INTERVAL_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ results: [] });
  }

  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  // Restrict to exactly the area the routing graph covers: a confident
  // match outside it is worse than no match, because the router then has
  // to reject it. Uses COVERAGE_BOUNDS rather than DEMO_CITY.bounds - the
  // latter is a narrower display box that cuts off Ocean Beach and most of
  // Golden Gate Park, which made "Ocean Beach" resolve to an unrelated
  // company downtown.
  const b = COVERAGE_BOUNDS;
  const url =
    `${NOMINATIM}?format=jsonv2&limit=6&addressdetails=0` +
    `&viewbox=${b.west},${b.north},${b.east},${b.south}&bounded=1` +
    `&q=${encodeURIComponent(q)}`;

  try {
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
    const results: GeocodeHit[] = raw.map((r) => ({
      label: r.display_name,
      lat: Number(r.lat),
      lng: Number(r.lon),
    }));
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      {
        results: [],
        error: `Address lookup failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 502 }
    );
  }
}
