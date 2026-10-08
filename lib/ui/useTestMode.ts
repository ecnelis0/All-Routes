"use client";

import { useSyncExternalStore } from "react";

/**
 * True when the page was opened with `?testmode` in the URL.
 *
 * "Simulate ride" (a synthetic rider driving the real navigation code, so
 * navigation can be checked on a desktop without riding) is a testing
 * tool, not a rider feature: the owner asked for it to be removed from the
 * app. It stays reachable for testing behind this flag.
 */
const subscribe = () => () => {};
const read = () => new URLSearchParams(window.location.search).has("testmode");

export function useTestMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
