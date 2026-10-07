"use client";

import { useSyncExternalStore } from "react";
import { loadSaved, STORAGE_KEY, subscribe, type SavedRoute } from "./store";

/**
 * Saved routes as React state, kept in step with saves, renames and
 * deletes - in this tab and in other tabs of the same browser.
 *
 * useSyncExternalStore needs a stable snapshot, so the parsed list is
 * cached against the raw stored string and only re-parsed when it changes.
 */
let lastRaw: string | null | undefined;
let lastList: SavedRoute[] = [];
const EMPTY: SavedRoute[] = [];

function snapshot(): SavedRoute[] {
  const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastList = loadSaved();
  }
  return lastList;
}

export function useSavedRoutes(): SavedRoute[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
