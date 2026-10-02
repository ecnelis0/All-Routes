import type { LatLng } from "../types";

/**
 * Fetches San Francisco's official LiDAR-measured building footprints for
 * the corridor a route runs through.
 *
 * See `app/api/buildings/route.ts` for why this replaces the vector-tile
 * buildings: those are real, but generalised at zoom 14, so roughly a
 * third of the city's buildings are absent.
 */

export interface BuildingsResult {
  geojson: GeoJSON.FeatureCollection;
  /** Buildings actually returned, for reporting and tests. */
  count: number;
  /** Set when one or more chunk requests failed; the rest are still usable. */
  partial: boolean;
}

/**
 * Chunk size in degrees. The endpoint refuses boxes larger than 0.08 to
 * stop a single request pulling half the city, and a cross-town route
 * spans more than that, so the corridor is tiled.
 */
const CHUNK_DEGREES = 0.05;
/** Corridor half-width. Buildings further than this are never in frame at tour pitch. */
const CORRIDOR_PADDING_DEGREES = 0.004; // ~450m

export function corridorChunks(
  path: LatLng[],
  chunk = CHUNK_DEGREES
): { south: number; west: number; north: number; east: number }[] {
  if (path.length === 0) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of path) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  minLat -= CORRIDOR_PADDING_DEGREES;
  maxLat += CORRIDOR_PADDING_DEGREES;
  minLng -= CORRIDOR_PADDING_DEGREES;
  maxLng += CORRIDOR_PADDING_DEGREES;

  const out: { south: number; west: number; north: number; east: number }[] = [];
  for (let lat = minLat; lat < maxLat; lat += chunk) {
    for (let lng = minLng; lng < maxLng; lng += chunk) {
      out.push({
        south: lat,
        west: lng,
        north: Math.min(lat + chunk, maxLat),
        east: Math.min(lng + chunk, maxLng),
      });
    }
  }
  return out;
}

export async function fetchCorridorBuildings(
  path: LatLng[],
  signal?: AbortSignal
): Promise<BuildingsResult> {
  const chunks = corridorChunks(path);
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  let partial = false;

  // Sequential rather than parallel: this is a free public dataset, and a
  // cross-town route is a dozen chunks. Hammering it concurrently is how
  // you get rate-limited for everyone.
  for (const c of chunks) {
    try {
      const res = await fetch(
        `/api/buildings?south=${c.south}&west=${c.west}&north=${c.north}&east=${c.east}`,
        { signal }
      );
      const json = (await res.json()) as GeoJSON.FeatureCollection & { error?: string };
      if (!res.ok || json.error) {
        partial = true;
        continue;
      }
      for (const f of json.features ?? []) {
        // Chunks share edges, and a footprint straddling one comes back
        // from both - de-duplicate or it is extruded twice, which shows
        // up as z-fighting on the shared walls.
        const id = String((f.properties as { id?: string } | null)?.id ?? "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        features.push(f);
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      partial = true;
    }
  }

  return {
    geojson: { type: "FeatureCollection", features },
    count: features.length,
    partial,
  };
}
