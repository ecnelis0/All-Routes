import type { RouteSummary } from "../routing/service";
import type { Poi } from "../interests/catalog";
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
}

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
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
