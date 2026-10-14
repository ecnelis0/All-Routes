import { addPhoto, deleteSaved, loadSaved, removePhoto, type KeyValueStore, type RidePhoto } from "./store";

/**
 * RIDE PHOTOS - the image files behind the `photos` records of a saved
 * route (lib/saved/store.ts).
 *
 * Kept in IndexedDB, not localStorage: a single phone photo is bigger than
 * everything localStorage allows a site. Like the saved routes themselves
 * they live in this browser on this device only. The functions below keep
 * the two stores in step, so there is never a record without its image or
 * an image no record points to.
 */

/** Where the image files go - injectable for tests. */
export interface PhotoFiles {
  put(id: string, file: Blob): Promise<void>;
  get(id: string): Promise<Blob | null>;
  remove(ids: string[]): Promise<void>;
}

const DB_NAME = "allroutes.photos.v1";
const FILES = "files";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FILES);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function inFiles<T>(mode: IDBTransactionMode, work: (files: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(FILES, mode);
      const req = work(tx.objectStore(FILES));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function browserPhotoFiles(): PhotoFiles | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    put: async (id, file) => {
      await inFiles("readwrite", (files) => files.put(file, id));
    },
    get: async (id) => ((await inFiles<Blob>("readonly", (files) => files.get(id))) as Blob | undefined) ?? null,
    remove: async (ids) => {
      await inFiles("readwrite", (files) => {
        for (const id of ids) files.delete(id);
      });
    },
  };
}

/** Longest side a stored photo keeps. Plenty for a full-screen view; a tenth of a camera original. */
export const PHOTO_MAX_SIDE = 1600;

/** New width and height for a photo, keeping its shape and never enlarging it. */
export function fitWithin(width: number, height: number, maxSide = PHOTO_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Shrinks a photo before it is stored. Falls back to the original if the browser cannot decode it. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return out ?? file;
  } catch {
    return file;
  }
}

/** Saves one photo on a pin: its record first (which can refuse), then the image - and no record left behind if the image fails. */
export async function attachPhoto(
  routeId: string,
  pinId: string,
  file: Blob,
  files: PhotoFiles,
  store?: KeyValueStore | null,
  now: Date = new Date()
): Promise<RidePhoto> {
  const photo = addPhoto(routeId, pinId, store, now);
  try {
    await files.put(photo.id, file);
  } catch (e) {
    removePhoto(routeId, photo.id, store);
    throw e;
  }
  return photo;
}

export async function detachPhoto(routeId: string, photoId: string, files: PhotoFiles, store?: KeyValueStore | null) {
  removePhoto(routeId, photoId, store);
  await files.remove([photoId]);
}

/** Deleting a saved route takes its photos with it. */
export async function deleteSavedWithPhotos(routeId: string, files: PhotoFiles | null, store?: KeyValueStore | null) {
  const ids = (loadSaved(store).find((r) => r.id === routeId)?.photos ?? []).map((p) => p.id);
  deleteSaved(routeId, store);
  if (files && ids.length) await files.remove(ids);
}
