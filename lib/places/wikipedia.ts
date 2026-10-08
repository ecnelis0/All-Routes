import type { LatLng } from "../types";
import { alongPath, distanceToPath } from "../ui/geometry";

/**
 * PLACES ALONG THE WAY, from Wikipedia: photo, a short "why go", and a
 * link back - for the map pins and the 3D tour's place cards.
 *
 * Wikipedia because it is free, keyless, openly licensed (text CC BY-SA,
 * photos via Wikimedia Commons, credited and linked), and covers what a
 * rider would ride to: beaches, parks, viewpoints, landmarks. Its
 * location search also returns schools, houses and neighbourhoods, so
 * places are kept only when Wikipedia's own short description says they
 * are something worth stopping for.
 */

export interface WikiPlace {
  id: string;
  title: string;
  /** Wikipedia's short description, e.g. "Beach in San Francisco". */
  description: string;
  /** The opening sentences of the article - the "why go". */
  extract: string;
  image: string | null;
  url: string;
  lat: number;
  lng: number;
  emoji: string;
  /** Metres along the route where it comes up, and how far off the route it is. */
  along: number;
  offMeters: number;
}

/** What a place must be, by Wikipedia's description or title, to be worth showing. */
const KINDS: { re: RegExp; emoji: string }[] = [
  { re: /\bbeach\b/i, emoji: "🏖️" },
  { re: /\b(park|garden|gardens|forest|meadow|preserve|reserve)\b/i, emoji: "🌳" },
  { re: /\b(viewpoint|overlook|lookout|vista|hill|summit|peak|bluff|cliffs?)\b/i, emoji: "🌄" },
  { re: /\b(lake|reservoir|lagoon|creek|waterfall)\b/i, emoji: "💧" },
  { re: /\b(museum|gallery|art center|palace of fine arts)\b/i, emoji: "🏛️" },
  { re: /\b(bridge)\b/i, emoji: "🌉" },
  { re: /\b(pier|wharf|lighthouse|harbor|harbour|marina)\b/i, emoji: "⚓" },
  { re: /\b(monument|memorial|statue|landmark|historic site|fort|battery|ruins)\b/i, emoji: "🗿" },
  { re: /\b(mural|public art|sculpture)\b/i, emoji: "🎨" },
  { re: /\b(plaza|square|market|zoo|aquarium|windmill|tower|observatory|stadium)\b/i, emoji: "📍" },
];
/** Never worth a detour, whatever else the description says. */
const NOT_A_STOP =
  /\b(school|college|university|neighbou?rhood|district|company|corporation|street|avenue|boulevard|highway|station|house|residence|church|cemetery|hospital|apartment|hotel|office|headquarters|event|reading|festival|incident|riot|shooting|earthquake|fire|protest)\b/i;

/** The emoji for a place worth showing, or null if it is not one. */
export function classifyPlace(title: string, description: string): string | null {
  const text = `${description} ${title}`;
  if (NOT_A_STOP.test(description)) return null;
  for (const k of KINDS) if (k.re.test(text)) return k.emoji;
  return null;
}

/** Points every `step` metres along the path, to search around. */
export function samplePoints(path: LatLng[], step: number): LatLng[] {
  const out: LatLng[] = [];
  if (path.length === 0) return out;
  out.push(path[0]);
  let carried = 0;
  for (let i = 1; i < path.length; i++) {
    carried += distanceToPath(path[i], [path[i - 1], path[i - 1]]);
    if (carried >= step) {
      out.push(path[i]);
      carried = 0;
    }
  }
  const last = path[path.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

interface RawPage {
  pageid: number;
  title: string;
  description?: string;
  extract?: string;
  thumbnail?: { source: string };
  coordinates?: { lat: number; lon: number }[];
}

/** One Wikipedia query: pages near a point, with photo, description and opening sentences. */
export function geosearchUrl(p: LatLng, radiusMeters: number): string {
  const q = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "geosearch",
    ggscoord: `${p.lat}|${p.lng}`,
    ggsradius: String(radiusMeters),
    ggslimit: "40",
    prop: "pageimages|extracts|description|coordinates",
    piprop: "thumbnail",
    pithumbsize: "480",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    exlimit: "max",
    origin: "*",
  });
  return `https://en.wikipedia.org/w/api.php?${q}`;
}

export type Fetcher = (url: string) => Promise<{ query?: { pages?: Record<string, RawPage> } }>;

const cache = new Map<string, RawPage[]>();

async function pagesNear(p: LatLng, radius: number, fetcher: Fetcher): Promise<RawPage[]> {
  // ~110 m grid: neighbouring routes reuse each other's lookups.
  const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)},${radius}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const json = await fetcher(geosearchUrl(p, radius));
  const pages = Object.values(json.query?.pages ?? {});
  cache.set(key, pages);
  return pages;
}

export const SEARCH_STEP_METERS = 1200;
export const SEARCH_RADIUS_METERS = 1000;
/** A place further than this from the route is not "along the way". */
export const MAX_OFF_ROUTE_METERS = 600;
export const MAX_PLACES = 25;

export async function placesAlongRoute(path: LatLng[], fetcher: Fetcher): Promise<WikiPlace[]> {
  const points = samplePoints(path, SEARCH_STEP_METERS);
  const byId = new Map<number, RawPage>();
  // A few at a time - polite to Wikipedia, still quick.
  for (let i = 0; i < points.length; i += 4) {
    const batch = await Promise.all(
      points.slice(i, i + 4).map((p) => pagesNear(p, SEARCH_RADIUS_METERS, fetcher).catch(() => []))
    );
    for (const pages of batch) for (const pg of pages) byId.set(pg.pageid, pg);
  }
  const places: WikiPlace[] = [];
  for (const pg of byId.values()) {
    const c = pg.coordinates?.[0];
    if (!c || !pg.extract) continue;
    const emoji = classifyPlace(pg.title, pg.description ?? "");
    if (!emoji) continue;
    const at = { lat: c.lat, lng: c.lon };
    const off = distanceToPath(at, path);
    if (off > MAX_OFF_ROUTE_METERS) continue;
    places.push({
      id: String(pg.pageid),
      title: pg.title,
      description: pg.description ?? "",
      extract: pg.extract.trim(),
      image: pg.thumbnail?.source ?? null,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pg.title.replace(/ /g, "_"))}`,
      lat: c.lat,
      lng: c.lon,
      emoji,
      along: alongPath(at, path),
      offMeters: Math.round(off),
    });
  }
  // Prefer places with a photo and close to the route, then show them in riding order.
  return places
    .sort((a, b) => Number(Boolean(b.image)) - Number(Boolean(a.image)) || a.offMeters - b.offMeters)
    .slice(0, MAX_PLACES)
    .sort((a, b) => a.along - b.along);
}
