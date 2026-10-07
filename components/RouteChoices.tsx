"use client";

import { useState } from "react";
import type { RouteDescription } from "@/lib/ui/routeDescription";

/**
 * The "what this route did" list - ✓ Avoided hills, ✕ Did not avoid
 * traffic lights, ... - shared by the sidebar, the 3D tour and navigation
 * so a route is described the same way everywhere it appears.
 */
export function RouteChoiceList({ description, tone = "light" }: { description: RouteDescription; tone?: "light" | "dark" }) {
  const yes = tone === "dark" ? "text-emerald-300" : "text-emerald-700";
  const no = tone === "dark" ? "text-slate-300" : "text-slate-500";
  return (
    <ul className="flex flex-col gap-0.5 text-xs" data-testid="route-choices">
      {description.choices.map((c) => (
        <li key={c.text} className={c.honoured ? yes : no}>
          {c.honoured ? "✓" : "✕"} {c.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * Collapsible version for full-screen views (3D tour, navigation), where
 * on a phone the sidebar is not on screen at all.
 */
export function RouteDetailsToggle({ description, className = "" }: { description: RouteDescription; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded-full border border-white/20 bg-slate-950/75 px-3 py-1 text-xs font-medium text-white backdrop-blur"
      >
        {open ? "Hide route details" : "Route details"}
      </button>
      {open && (
        <div className="max-w-72 rounded-lg bg-slate-950/80 px-3 py-2 text-white backdrop-blur">
          <p className="mb-1 text-xs font-semibold">{description.title}</p>
          <RouteChoiceList description={description} tone="dark" />
          <p className="mt-1 text-[11px] text-slate-300">{description.stats.join(" · ")}</p>
        </div>
      )}
    </div>
  );
}
