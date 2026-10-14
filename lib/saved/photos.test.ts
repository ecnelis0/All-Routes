import { describe, expect, it } from "vitest";
import { attachPhoto, deleteSavedWithPhotos, detachPhoto, fitWithin, PHOTO_MAX_SIDE, type PhotoFiles } from "./photoFiles";
import {
  addPhoto,
  loadSaved,
  markCompleted,
  MAX_PHOTOS_PER_ROUTE,
  pinsOf,
  removePhoto,
  SaveError,
  saveRoute,
  type KeyValueStore,
} from "./store";
import { planCustomRoute } from "../routing/service";

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function memoryFiles(failPut = false): PhotoFiles & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return {
    data,
    put: async (id, file) => {
      if (failPut) throw new Error("QuotaExceededError");
      data.set(id, file);
    },
    get: async (id) => data.get(id) ?? null,
    remove: async (ids) => {
      for (const id of ids) data.delete(id);
    },
  };
}

const FROM = { lat: 37.79484, lng: -122.43103 };
const TO = { lat: 37.76308, lng: -122.42542 };
const STOP = { lat: 37.7765, lng: -122.4331 };
const entry = {
  name: "To the Mission",
  from: { label: "Pacific Heights, San Francisco", point: FROM },
  to: { label: "Mission, San Francisco", point: TO },
  settings: { avoidElevation: false, fewerSignals: false },
  source: "route" as const,
  route: planCustomRoute(FROM, TO, [STOP], "balanced"),
};
const photo = () => new Blob(["jpeg bytes"], { type: "image/jpeg" });

describe("pinned locations of a saved route", () => {
  it("are the start, each stop in order, and the destination", () => {
    const s = saveRoute(entry, memory());
    expect(pinsOf(s).map((p) => [p.id, p.name, p.stopNumber])).toEqual([
      ["start", "Pacific Heights", undefined],
      ["stop-1", "Stop 1", 1],
      ["end", "Mission", undefined],
    ]);
    expect(pinsOf(s)[1].position).toEqual(STOP);
  });

  it("use a For-you ride's place names", () => {
    const named = { ...entry.route, interestStops: [{ id: "node/1", name: "Boba Guys", emoji: "🧋", ...STOP }] };
    const s = saveRoute({ ...entry, route: named }, memory());
    expect(pinsOf(s)[1]).toMatchObject({ id: "node/1", name: "Boba Guys", emoji: "🧋", stopNumber: 1 });
  });
});

describe("ride photos", () => {
  it("cannot be added until the route has been navigated to the end", () => {
    const store = memory();
    const s = saveRoute(entry, store);
    expect(() => addPhoto(s.id, "start", store)).toThrow(/Finish navigating/);
    markCompleted(s.id, store, new Date("2026-10-11T18:00:00Z"));
    expect(loadSaved(store)[0].completedAt).toBe("2026-10-11T18:00:00.000Z");
    expect(addPhoto(s.id, "start", store).pinId).toBe("start");
  });

  it("are saved on the pin they were added to, and survive a reload of both stores", async () => {
    const store = memory();
    const files = memoryFiles();
    const s = saveRoute(entry, store);
    markCompleted(s.id, store);
    const a = await attachPhoto(s.id, "stop-1", photo(), files, store);
    const b = await attachPhoto(s.id, "end", photo(), files, store);
    const back = loadSaved(store)[0];
    expect(back.photos!.map((p) => [p.id, p.pinId])).toEqual([
      [a.id, "stop-1"],
      [b.id, "end"],
    ]);
    expect(await (await files.get(a.id))!.text()).toBe("jpeg bytes");
    // The route itself is untouched by any of this.
    expect(back.route).toEqual(entry.route);
  });

  it("refuse a pin that is not on the route, and stop at the limit", () => {
    const store = memory();
    const s = saveRoute(entry, store);
    markCompleted(s.id, store);
    expect(() => addPhoto(s.id, "stop-9", store)).toThrow(SaveError);
    expect(() => addPhoto("gone", "start", store)).toThrow(/no longer exists/);
    for (let i = 0; i < MAX_PHOTOS_PER_ROUTE; i++) addPhoto(s.id, "start", store);
    expect(() => addPhoto(s.id, "start", store)).toThrow(/remove one first/);
    expect(loadSaved(store)[0].photos).toHaveLength(MAX_PHOTOS_PER_ROUTE);
  });

  it("leave no record behind when the image could not be stored", async () => {
    const store = memory();
    const s = saveRoute(entry, store);
    markCompleted(s.id, store);
    await expect(attachPhoto(s.id, "start", photo(), memoryFiles(true), store)).rejects.toThrow("QuotaExceededError");
    expect(loadSaved(store)[0].photos).toEqual([]);
  });

  it("are removed one at a time, image and record together", async () => {
    const store = memory();
    const files = memoryFiles();
    const s = saveRoute(entry, store);
    markCompleted(s.id, store);
    const a = await attachPhoto(s.id, "start", photo(), files, store);
    const b = await attachPhoto(s.id, "start", photo(), files, store);
    await detachPhoto(s.id, a.id, files, store);
    expect(loadSaved(store)[0].photos!.map((p) => p.id)).toEqual([b.id]);
    expect([...files.data.keys()]).toEqual([b.id]);
    removePhoto(s.id, "not-a-photo", store); // harmless
    expect(loadSaved(store)[0].photos).toHaveLength(1);
  });

  it("go when their route is deleted - and only theirs", async () => {
    const store = memory();
    const files = memoryFiles();
    const one = saveRoute(entry, store);
    const two = saveRoute(entry, store);
    markCompleted(one.id, store);
    markCompleted(two.id, store);
    await attachPhoto(one.id, "start", photo(), files, store);
    const kept = await attachPhoto(two.id, "end", photo(), files, store);
    await deleteSavedWithPhotos(one.id, files, store);
    expect(loadSaved(store).map((r) => r.id)).toEqual([two.id]);
    expect([...files.data.keys()]).toEqual([kept.id]);
  });

  it("are shrunk to fit, keeping their shape and never enlarged", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: PHOTO_MAX_SIDE, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: PHOTO_MAX_SIDE });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
