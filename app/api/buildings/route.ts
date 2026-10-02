import { NextResponse } from "next/server";
import { COVERAGE_BOUNDS } from "@/lib/data/coverage";

/**
 * San Francisco's official building footprints, for a bounding box.
 *
 * WHY THIS EXISTS. The 3D tour's buildings came from OpenFreeMap's
 * OpenMapTiles vector tiles. Those are genuinely real - OpenStreetMap
 * footprints, and 98.8% carry a surveyed height, with the tallest in the
 * Financial District measuring 326m, which is Salesforce Tower exactly.
 * But the tiles stop at zoom 14 and are generalised there: counted
 * against OpenStreetMap over one downtown block, only 63 of 94 buildings
 * survived into the tile. Roughly a third of the city was simply not
 * drawn, and at tour altitude that is visible as gaps.
 *
 * This proxies DataSF `ynuv-fyni` - the City and County of San
 * Francisco's own footprint layer, 177,023 buildings, with heights
 * measured by LiDAR rather than inferred from storey counts. For the same
 * downtown block it returns 69 buildings.
 *
 * Queried per bounding box rather than downloaded wholesale: the full
 * dataset is ~139MB of raw geometry, which is neither committable nor
 * shippable to a browser, and a tour only ever needs the corridor it
 * flies down.
 *
 * ON THE HEIGHT FIELDS, which are easy to get wrong and silently wrong
 * when you do: `hgt_meancm` is already the height ABOVE GROUND in
 * centimetres, and `gnd_mincm` is the terrain elevation beneath. An
 * earlier version subtracted the two, which made almost every value
 * negative and discarded 169,000 of 177,000 buildings as "no usable
 * height" while looking like a data-quality problem rather than a bug.
 */
export const runtime = "nodejs";

const RESOURCE = "https://data.sfgov.org/resource/ynuv-fyni.json";
const UA = "no-roll-models/0.1 (bike safety routing)";

/** Guards against a pathological request pulling half the city. */
const MAX_SPAN_DEGREES = 0.08; // ~9km
const MAX_FEATURES = 6000;

interface Row {
  sf16_bldgid?: string;
  hgt_meancm?: string;
  hgt_maxcm?: string;
  shape?: { type: string; coordinates: number[][][][] };
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const nums = ["south", "west", "north", "east"].map((k) => Number(sp.get(k)));
  if (!nums.every(Number.isFinite)) {
    return NextResponse.json(
      { error: "Requires numeric south, west, north, east query params." },
      { status: 400 }
    );
  }
  let [south, west, north, east] = nums;
  if (south > north) [south, north] = [north, south];
  if (west > east) [west, east] = [east, west];

  if (north - south > MAX_SPAN_DEGREES || east - west > MAX_SPAN_DEGREES) {
    return NextResponse.json(
      { error: `Bounding box too large (max ${MAX_SPAN_DEGREES} degrees per side).` },
      { status: 400 }
    );
  }
  // Nothing outside the routable area can appear in a tour anyway.
  const b = COVERAGE_BOUNDS;
  if (north < b.south || south > b.north || east < b.west || west > b.east) {
    return NextResponse.json({ type: "FeatureCollection", features: [] });
  }

  const url =
    `${RESOURCE}?$select=sf16_bldgid,hgt_meancm,hgt_maxcm,shape` +
    `&$where=${encodeURIComponent(
      `within_box(shape, ${north}, ${west}, ${south}, ${east})`
    )}&$limit=${MAX_FEATURES}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      // Footprints change on the order of months; a long cache keeps the
      // tour responsive and keeps us off a free public API.
      next: { revalidate: 86_400 },
    });
    if (!res.ok) throw new Error(`DataSF HTTP ${res.status}`);
    const rows = (await res.json()) as Row[];

    const features = [];
    for (const r of rows) {
      const outer = r.shape?.coordinates?.[0]?.[0];
      if (!outer || outer.length < 4) continue;
      const meanCm = Number(r.hgt_meancm);
      const peakCm = Number(r.hgt_maxcm);
      // Render the PEAK, not the mean. LiDAR averages every return over
      // the footprint, so a tower with a wide podium reports a mean far
      // below its actual top - one downtown building here has a mean of
      // 19.3m against a peak of 111.5m. Using the mean would flatten the
      // skyline into something that is numerically defensible and
      // visibly wrong.
      const cm = Number.isFinite(peakCm) && peakCm > 0 ? peakCm : meanCm;
      if (!Number.isFinite(cm) || cm <= 0) continue;
      features.push({
        type: "Feature" as const,
        geometry: { type: "Polygon" as const, coordinates: [outer] },
        properties: {
          id: r.sf16_bldgid ?? null,
          /** Metres above ground - LiDAR peak over the footprint. */
          height: Math.round(cm) / 100,
          /** Mean return, kept for reference; lower than `height` on towers. */
          meanHeight: Number.isFinite(meanCm) ? Math.round(meanCm) / 100 : null,
        },
      });
    }

    return NextResponse.json({ type: "FeatureCollection", features });
  } catch (err) {
    // The tour keeps its vector-tile buildings if this fails, so a failure
    // degrades detail rather than breaking the view.
    return NextResponse.json(
      {
        type: "FeatureCollection",
        features: [],
        error: `Building footprints unavailable: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      },
      { status: 502 }
    );
  }
}
