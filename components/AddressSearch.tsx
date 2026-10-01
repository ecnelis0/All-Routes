"use client";

import { useEffect, useRef, useState } from "react";
import type { LatLng } from "@/lib/types";

interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
}

interface Props {
  placeholder: string;
  value: string;
  onValueChange: (text: string) => void;
  /** Fires with a resolved point when the user picks a suggestion, and with null whenever the text is edited away from that pick. */
  onSelect: (point: LatLng | null, label: string) => void;
}

/**
 * Address input with suggestions, backed by `/api/geocode`.
 *
 * Replaces Google's `places.Autocomplete`, which this project cannot use:
 * the Cloud project has only the Maps JavaScript API enabled, and legacy
 * Places Autocomplete is closed to new customers regardless.
 *
 * Keeps one behaviour from the old implementation that is easy to lose and
 * matters: editing the text after choosing a suggestion clears the resolved
 * coordinate. Without that, retyping an address and pressing Enter leaves
 * the app routing from the *previously* picked place while displaying the
 * new text - a wrong route that looks right.
 */
export default function AddressSearch({ placeholder, value, onValueChange, onSelect }: Props) {
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Guards against an older, slower lookup landing after a newer one and
  // repopulating the list with suggestions for a query already typed past.
  const queryIdRef = useRef(0);
  const justPickedRef = useRef(false);

  useEffect(() => {
    if (justPickedRef.current) {
      // The value changed because we filled it in from a pick, not because
      // the user typed - don't immediately re-search for what they chose.
      justPickedRef.current = false;
      return;
    }
    const q = value.trim();
    const id = ++queryIdRef.current;

    if (q.length < 3) {
      // Deferred rather than set synchronously: clearing state during the
      // effect body triggers a cascading re-render on every keystroke under
      // three characters, which React (and the lint rule) rightly object to.
      const clear = setTimeout(() => {
        setHits([]);
        setOpen(false);
        setLoading(false);
      }, 0);
      return () => clearTimeout(clear);
    }

    // Debounced: Nominatim's usage policy caps request rate, and firing on
    // every keystroke would both breach it and mostly waste the results.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const json = (await res.json()) as { results?: GeocodeHit[] };
        if (id !== queryIdRef.current) return;
        setHits(json.results ?? []);
        setOpen((json.results ?? []).length > 0);
        setActiveIndex(-1);
      } catch {
        if (id === queryIdRef.current) setHits([]);
      } finally {
        if (id === queryIdRef.current) setLoading(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(hit: GeocodeHit) {
    justPickedRef.current = true;
    queryIdRef.current++; // cancel any in-flight lookup for the old text
    onValueChange(hit.label);
    onSelect({ lat: hit.lat, lng: hit.lng }, hit.label);
    setOpen(false);
    setHits([]);
    setActiveIndex(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[activeIndex >= 0 ? activeIndex : 0]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        onChange={(e) => {
          onValueChange(e.target.value);
          onSelect(null, e.target.value);
        }}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-black"
      />
      {loading && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">
          …
        </span>
      )}
      {open && hits.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {hits.map((h, i) => (
            <li key={`${h.lat},${h.lng},${i}`}>
              <button
                type="button"
                onClick={() => pick(h)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`block w-full px-2 py-1.5 text-left text-xs leading-snug text-black ${
                  i === activeIndex ? "bg-blue-50" : "hover:bg-slate-50"
                }`}
              >
                {h.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
