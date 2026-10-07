"use client";

import Link from "next/link";
import { useState } from "react";
import { saveRoute, SaveError, type SavedRoute } from "@/lib/saved/store";

/**
 * "Save route" -> name it -> saved, with a link to the Saved tab. Used by
 * the safety router and by Explore. Give it a `key` that changes with the
 * route so a new route starts unsaved.
 */
export default function SaveRouteButton({
  defaultName,
  build,
}: {
  defaultName: string;
  /** Everything to store except id/name/date - built only when saving. */
  build: () => Omit<SavedRoute, "id" | "savedAt" | "name">;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(defaultName);
  const [saved, setSaved] = useState<SavedRoute | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    try {
      setSaved(saveRoute({ ...build(), name }));
      setNaming(false);
      setError(null);
    } catch (e) {
      setError(e instanceof SaveError ? e.message : "Could not save this route.");
    }
  }

  if (saved) {
    return (
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800" role="status" data-testid="saved-confirmation">
        ✓ Saved as <span className="font-semibold">{saved.name}</span> ·{" "}
        <Link href={`/saved?id=${saved.id}`} className="font-semibold underline">
          Open in Saved
        </Link>
      </p>
    );
  }
  if (!naming) {
    return (
      <button
        type="button"
        onClick={() => setNaming(true)}
        className="rounded-md border border-slate-900 bg-white px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
      >
        Save route
      </button>
    );
  }
  return (
    <form
      className="flex flex-col gap-1.5 rounded-md border border-slate-300 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="text-xs font-medium text-black/70" htmlFor="save-route-name">
        Name this route
      </label>
      <input
        id="save-route-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        maxLength={80}
        className="rounded border border-slate-300 px-2 py-1 text-sm text-black"
      />
      <div className="flex gap-1.5">
        <button type="submit" className="flex-1 rounded bg-slate-900 px-2 py-1.5 text-xs font-semibold text-white">
          Save
        </button>
        <button
          type="button"
          onClick={() => setNaming(false)}
          className="rounded border border-slate-300 px-2 py-1.5 text-xs font-medium"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </form>
  );
}
