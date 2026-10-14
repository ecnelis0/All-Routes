"use client";

import { useEffect, useMemo, useState } from "react";
import { attachPhoto, browserPhotoFiles, detachPhoto, shrinkPhoto } from "@/lib/saved/photoFiles";
import { MAX_PHOTOS_PER_ROUTE, pinsOf, SaveError, type SavedRoute } from "@/lib/saved/store";

/**
 * Photos from the ride, on a saved route's pinned locations: the start,
 * each stop and the destination. Offered once the route has been navigated
 * to the end. Saved in this browser with the route - see
 * lib/saved/photoFiles.ts.
 */
export default function RidePhotos({ s }: { s: SavedRoute }) {
  const files = useMemo(() => browserPhotoFiles(), []);
  const photos = useMemo(() => s.photos ?? [], [s.photos]);
  const ids = photos.map((p) => p.id).join(",");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busyPin, setBusyPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ url: string; label: string } | null>(null);

  // The images, as object URLs - made when the set of photos changes and
  // released again when it changes next or the panel closes.
  useEffect(() => {
    if (!files || !ids) return;
    let cancelled = false;
    const made: string[] = [];
    void Promise.all(
      ids.split(",").map(async (id) => {
        const file = await files.get(id).catch(() => null);
        if (!file) return null;
        const url = URL.createObjectURL(file);
        made.push(url);
        return [id, url] as const;
      })
    ).then((pairs) => {
      if (!cancelled) setUrls(Object.fromEntries(pairs.filter((p) => p !== null)));
    });
    return () => {
      cancelled = true;
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [files, ids]);

  if (!s.completedAt) {
    return (
      <section className="text-xs" data-testid="ride-photos">
        <h2 className="mb-1 font-semibold">Ride photos</h2>
        <p className="text-black/60">
          Navigate this route to the end, and you can add photos to its pinned locations here.
        </p>
      </section>
    );
  }

  async function add(pinId: string, picked: FileList | null) {
    if (!files || !picked || picked.length === 0) return;
    setBusyPin(pinId);
    setError(null);
    try {
      for (const file of Array.from(picked)) {
        if (!file.type.startsWith("image/")) throw new SaveError(`${file.name} is not a photo.`);
        await attachPhoto(s.id, pinId, await shrinkPhoto(file), files);
      }
    } catch (e) {
      setError(e instanceof SaveError ? e.message : "Could not save that photo - this browser may be out of space.");
    } finally {
      setBusyPin(null);
    }
  }

  return (
    <section className="text-xs" data-testid="ride-photos">
      <h2 className="font-semibold">Ride photos</h2>
      <p className="mb-2 text-black/60">
        Ridden {new Date(s.completedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} ·{" "}
        {photos.length} of {MAX_PHOTOS_PER_ROUTE} photos · saved in this browser
      </p>
      {!files ? (
        <p className="text-red-700">This browser does not allow saving photos.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {pinsOf(s).map((pin) => {
            const mine = photos.filter((p) => p.pinId === pin.id);
            const label = `${pin.emoji} ${pin.name}`;
            return (
              <li key={pin.id} className="rounded-lg border border-slate-200 p-2" data-testid="photo-pin">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {pin.stopNumber !== undefined ? `${pin.stopNumber}. ` : ""}
                    {label}
                  </span>
                  <label className="shrink-0 cursor-pointer rounded-md border border-slate-300 px-2 py-1 font-medium hover:bg-slate-50 has-[:disabled]:cursor-wait has-[:disabled]:opacity-50">
                    {busyPin === pin.id ? "Saving…" : "Add photos"}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="sr-only"
                      aria-label={`Add photos to ${pin.name}`}
                      disabled={busyPin !== null}
                      onChange={(e) => {
                        const picked = e.target.files;
                        void add(pin.id, picked).then(() => {
                          e.target.value = ""; // the same file can be picked again
                        });
                      }}
                    />
                  </label>
                </div>
                {mine.length > 0 && (
                  <ul className="mt-2 grid grid-cols-4 gap-1.5">
                    {mine.map((p, i) => (
                      <li key={p.id} className="relative aspect-square overflow-hidden rounded-md bg-slate-100">
                        {urls[p.id] && (
                          <button
                            type="button"
                            className="block h-full w-full"
                            onClick={() => setViewing({ url: urls[p.id], label: `${pin.name}, photo ${i + 1}` })}
                          >
                            {/* A local object URL: next/image has nothing to optimise. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={urls[p.id]} alt={`${pin.name}, photo ${i + 1}`} className="h-full w-full object-cover" />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Remove photo ${i + 1} from ${pin.name}`}
                          onClick={() => void detachPhoto(s.id, p.id, files).catch(() => setError("Could not remove that photo."))}
                          className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-[11px] leading-none text-white hover:bg-black"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {error && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1 text-red-700" role="alert">
          {error}
        </p>
      )}
      {viewing && (
        <div
          role="dialog"
          aria-label={viewing.label}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setViewing(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing.url} alt={viewing.label} className="max-h-full max-w-full rounded-lg shadow-2xl" />
          <button
            type="button"
            onClick={() => setViewing(null)}
            className="absolute right-4 top-4 rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-900"
          >
            Close
          </button>
        </div>
      )}
    </section>
  );
}
