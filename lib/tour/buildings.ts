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
  /**
   * Set when a chunk failed, was truncated, or the total ceiling was hit.
   *
   * The caller must NOT hide the vector-tile buildings when this is true:
   * incomplete LiDAR coverage plus hidden tiles leaves visible holes
   * where whole neighbourhoods should be, which is worse than the
   * generalised tiles it replaced.
   */
  partial: boolean;
}

/**
 * Chunk size in degrees, ~1.3km a side.
 *
 * Sized against the endpoint's 6,000-feature cap, not against its 0.08
 * degree size limit. Those are very different constraints: a 0.05 degree
 * chunk is well inside the size limit but holds roughly 58,000 buildings
 * in the dense Sunset, so the request came back truncated to an arbitrary
 * 6,000 and the tour rendered scattered clumps with whole neighbourhoods
 * missing. A measured 0.01 degree box in the Sunset holds 2,322.
 */
const CHUNK_DEGREES = 0.012;
/** Corridor half-width. Buildings further than this are never in frame at tour pitch. */
const CORRIDOR_PADDING_DEGREES = 0.0025; // ~280m
/** Hard ceiling on buildings held in the browser at once. */
const MAX_TOTAL_FEATURES = 14_000;

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
      const cell = {
        south: lat,
        west: lng,
        north: Math.min(lat + chunk, maxLat),
        east: Math.min(lng + chunk, maxLng),
      };
      // Only cells the route actually passes through. A diagonal
      // cross-town route's bounding box is mostly empty of route, and
      // fetching that whole rectangle is both far slower and a lot of
      // buildings nobody will ever see.
      if (cellNearPath(cell, path)) out.push(cell);
    }
  }
  return out;
}

function cellNearPath(
  cell: { south: number; west: number; north: number; east: number },
  path: LatLng[]
): boolean {
  const cLat = (cell.south + cell.north) / 2;
  const cLng = (cell.west + cell.east) / 2;
  // Half-diagonal of the cell plus the corridor width.
  const reach = (cell.north - cell.south) / 2 + CORRIDOR_PADDING_DEGREES;
  for (const p of path) {
    if (Math.abs(p.lat - cLat) <= reach && Math.abs(p.lng - cLng) <= reach * 1.3) return true;
  }
  return false;
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
      // The endpoint caps at 6,000; coming back exactly at the cap means
      // the chunk was almost certainly cut short.
      if ((json.features?.length ?? 0) >= 6000) partial = true;
      for (const f of json.features ?? []) {
        if (features.length >= MAX_TOTAL_FEATURES) {
          partial = true;
          break;
        }
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
