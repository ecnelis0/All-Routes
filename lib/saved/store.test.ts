import { describe, expect, it } from "vitest";
import { deleteSaved, loadSaved, renameSaved, saveRoute, SaveError, shortPlace, STORAGE_KEY, type KeyValueStore } from "./store";
import { planRoutes } from "../routing/service";

function memory(limitBytes = Infinity): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > limitBytes) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
  };
}

const route = planRoutes({ lat: 37.79484, lng: -122.43103 }, { lat: 37.76308, lng: -122.42542 }, { avoidElevation: true })[1];
const entry = {
  name: "To the Mission",
  from: { label: "Pacific Heights, San Francisco", point: { lat: 37.79484, lng: -122.43103 } },
  to: { label: "Mission, San Francisco", point: { lat: 37.76308, lng: -122.42542 } },
  settings: { avoidElevation: true, fewerSignals: false },
  source: "route" as const,
  route,
};

describe("saved routes", () => {
  it("keeps EVERYTHING about the route, exactly - a round trip through storage changes nothing", () => {
    const store = memory();
    saveRoute(entry, store);
    const [back] = loadSaved(store);
    expect(back.route).toEqual(route);
    expect(back.settings).toEqual({ avoidElevation: true, fewerSignals: false });
    expect(back.from).toEqual(entry.from);
  });

  it("lists newest first, renames and deletes", () => {
    const store = memory();
    const a = saveRoute({ ...entry, name: "A" }, store, new Date("2026-10-01"));
    const b = saveRoute({ ...entry, name: "B" }, store, new Date("2026-10-02"));
    expect(loadSaved(store).map((r) => r.name)).toEqual(["B", "A"]);
    renameSaved(a.id, "  Commute  ", store);
    expect(loadSaved(store).find((r) => r.id === a.id)!.name).toBe("Commute");
    deleteSaved(b.id, store);
    expect(loadSaved(store).map((r) => r.name)).toEqual(["Commute"]);
  });

  it("names an unnamed save after its ends", () => {
    const store = memory();
    expect(saveRoute({ ...entry, name: "  " }, store).name).toBe(
      "Pacific Heights, San Francisco → Mission, San Francisco"
    );
    expect(shortPlace("Noe Valley, Mission, San Francisco")).toBe("Noe Valley");
  });

  it("says plainly when storage is full, and loses nothing already saved", () => {
    const one = JSON.stringify([{ ...entry, id: "x", savedAt: "" }]).length;
    const store = memory(one * 1.5);
    saveRoute(entry, store);
    expect(() => saveRoute(entry, store)).toThrow(SaveError);
    expect(loadSaved(store)).toHaveLength(1);
  });

  it("survives corrupt storage instead of breaking the Saved tab", () => {
    const store = memory();
    store.data.set(STORAGE_KEY, "{not json");
    expect(loadSaved(store)).toEqual([]);
    store.data.set(STORAGE_KEY, JSON.stringify([{ id: "ok", route: { path: [] } }, { junk: true }]));
    expect(loadSaved(store).map((r) => r.id)).toEqual(["ok"]);
  });

  it("fits comfortably: one long route is far below the ~5 MB browser limit", () => {
    const store = memory();
    saveRoute(entry, store);
    expect(store.data.get(STORAGE_KEY)!.length).toBeLessThan(300_000);
  });
});
