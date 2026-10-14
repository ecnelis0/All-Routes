import type { RouteSummary } from "../routing/service";
import { emojiFor, type Poi } from "../interests/catalog";
import type { LatLng } from "../types";

/**
 * SAVED ROUTES - everything about a confirmed route, kept so it can be
 * reopened, toured and navigated later from the Saved tab.
 *
 * Stored in the browser (localStorage) because the app has no accounts or
 * database yet: saves survive reloads and restarts, but live on this device
 * and browser only. Every read and write goes through this module, so
 * moving to a server-side store with logins later changes only this file.
 */

export const STORAGE_KEY = "allroutes.saved.v1";

export interface SavedRoute {
  id: string;
  name: string;
  savedAt: string;
  from: { label: string; point: LatLng };
  to: { label: string; point: LatLng };
  /** The settings the route was planned with. */
  settings: { avoidElevation: boolean; fewerSignals: boolean };
  /** Where it came from: the safety router, or an Explore ride. */
  source: "route" | "explore";
  /** The whole route as planned: path, stats, areas, elevation, stops... */
  route: RouteSummary;
  /** Explore rides: the places it visits, in order. */
  places?: Poi[];
  /** When the rider last navigated this route to its destination. Photos can be added from then on. */
  completedAt?: string;
  /** Photos from the ride, each on one pinned location - see `pinsOf`. */
  photos?: RidePhoto[];
}

/**
 * A photo the rider added to a pinned location after riding the route.
 * Only this record is kept here: the image itself is far too big for
 * localStorage and lives in lib/saved/photoFiles.ts under the same id.
 */
export interface RidePhoto {
  id: string;
  /** Which pin it belongs to - an id from `pinsOf`. */
  pinId: string;
  addedAt: string;
}

/** A place on a saved route that photos can be pinned to. */
export interface RoutePin {
  id: string;
  name: string;
  emoji: string;
  position: LatLng;
  /** 1-based visiting order for stops; absent for the start and destination. */
  stopNumber?: number;
}

export const MAX_PHOTOS_PER_ROUTE = 30;

/** The subset of the Storage API this needs - injectable for tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class SaveError extends Error {}

function browserStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // e.g. storage disabled in private browsing
  }
}

export function loadSaved(store: KeyValueStore | null = browserStore()): SavedRoute[] {
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Anything malformed is dropped rather than crashing the Saved tab.
    return Array.isArray(parsed)
      ? parsed.filter((r): r is SavedRoute => typeof r?.id === "string" && Array.isArray(r?.route?.path))
      : [];
  } catch {
    return [];
  }
}

function write(list: SavedRoute[], store: KeyValueStore | null) {
  if (!store) throw new SaveError("This browser does not allow saving (storage is turned off).");
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // A long route is ~100 KB; browsers allow ~5 MB per site.
    throw new SaveError("Storage is full - delete a saved route and try again.");
  }
  notify();
}

export function saveRoute(
  entry: Omit<SavedRoute, "id" | "savedAt">,
  store: KeyValueStore | null = browserStore(),
  now: Date = new Date()
): SavedRoute {
  const saved: SavedRoute = {
    ...entry,
    name: entry.name.trim() || `${entry.from.label} → ${entry.to.label}`,
    id: newId(now),
    savedAt: now.toISOString(),
  };
  write([saved, ...loadSaved(store)], store); // newest first
  return saved;
}

export function deleteSaved(id: string, store: KeyValueStore | null = browserStore()) {
  write(
    loadSaved(store).filter((r) => r.id !== id),
    store
  );
}

export function renameSaved(id: string, name: string, store: KeyValueStore | null = browserStore()) {
  const trimmed = name.trim();
  if (!trimmed) return;
  write(
    loadSaved(store).map((r) => (r.id === id ? { ...r, name: trimmed } : r)),
    store
  );
}

function newId(now: Date): string {
  return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The pinned locations of a saved route, in riding order: where it starts,
 * every stop, and where it ends. Stops are named places when the route
 * knows them (a "For you" ride), else the rider's own "Stop N".
 */
export function pinsOf(s: SavedRoute): RoutePin[] {
  const named = s.route.interestStops
    ? s.route.interestStops.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, position: { lat: p.lat, lng: p.lng } }))
    : s.places
      ? s.places.map((p) => ({ id: p.id, name: p.name, emoji: emojiFor(p.category), position: { lat: p.lat, lng: p.lng } }))
      : (s.route.customWaypoints ?? []).map((w, i) => ({ id: `stop-${i + 1}`, name: `Stop ${i + 1}`, emoji: "📍", position: w }));
  return [
    { id: "start", name: shortPlace(s.from.label), emoji: "🚩", position: s.from.point },
    ...named.map((p, i) => ({ ...p, stopNumber: i + 1 })),
    { id: "end", name: shortPlace(s.to.label), emoji: "🏁", position: s.to.point },
  ];
}

/** The rider navigated this route to the end - from now on it can hold photos. */
export function markCompleted(id: string, store: KeyValueStore | null = browserStore(), now: Date = new Date()) {
  write(
    loadSaved(store).map((r) => (r.id === id ? { ...r, completedAt: now.toISOString() } : r)),
    store
  );
}

/** Records a photo on one pin of a completed route. The caller stores the image under the returned id. */
export function addPhoto(
  routeId: string,
  pinId: string,
  store: KeyValueStore | null = browserStore(),
  now: Date = new Date()
): RidePhoto {
  const list = loadSaved(store);
  const route = list.find((r) => r.id === routeId);
  if (!route) throw new SaveError("That saved route no longer exists.");
  if (!route.completedAt) throw new SaveError("Finish navigating this route first - then you can add photos to it.");
  if (!pinsOf(route).some((p) => p.id === pinId)) throw new SaveError("That pinned location is not on this route.");
  if ((route.photos ?? []).length >= MAX_PHOTOS_PER_ROUTE) {
    throw new SaveError(`A route can hold ${MAX_PHOTOS_PER_ROUTE} photos - remove one first.`);
  }
  const photo: RidePhoto = { id: newId(now), pinId, addedAt: now.toISOString() };
  write(
    list.map((r) => (r.id === routeId ? { ...r, photos: [...(r.photos ?? []), photo] } : r)),
    store
  );
  return photo;
}

export function removePhoto(routeId: string, photoId: string, store: KeyValueStore | null = browserStore()) {
  write(
    loadSaved(store).map((r) => (r.id === routeId ? { ...r, photos: (r.photos ?? []).filter((p) => p.id !== photoId) } : r)),
    store
  );
}

/** "Noe Valley → North Beach" from long geocoder labels. */
export function shortPlace(label: string): string {
  return label.split(",")[0].trim() || label;
}

// --- change notifications, for useSyncExternalStore ------------------------
const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Saves made in another tab of the same browser.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) fn();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
function notify() {
  for (const fn of listeners) fn();
}
