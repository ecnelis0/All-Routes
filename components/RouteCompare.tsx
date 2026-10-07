"use client";

import { useMemo } from "react";
import type { RouteSummary } from "@/lib/routing/service";
import type { RouteDescription } from "@/lib/ui/routeDescription";
import { bestForBadges, compareRoutes } from "@/lib/ui/compareRoutes";
import { buildElevationProfile, type ElevationProfile } from "@/lib/tour/elevationProfile";
import ProfileChart, { profilePath, sharedScale } from "@/components/ProfileChart";
import { RouteChoiceList } from "@/components/RouteChoices";
import { ROUTE_COLOR_BY_KIND, type MapRouteKind } from "@/components/MapView";

/**
 * Every route side by side: the stats with the best value in each row
 * highlighted, "best for" badges, and each route's elevation profile - all
 * on ONE shared scale, plus an overlay of every profile together, so a
 * hilly route visibly towers over a flat one instead of each chart
 * stretching its own hills to fill its box.
 */

export interface CompareItem {
  kind: MapRouteKind;
  route: RouteSummary;
  description: RouteDescription;
}

const FT = 3.281;
const MI = 1609.34;
const OVERLAY_W = 760;
const OVERLAY_H = 150;

export default function RouteCompare({
  items,
  onSelect,
  onClose,
}: {
  items: CompareItem[];
  onSelect: (kind: MapRouteKind) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => compareRoutes(items.map((i) => i.route)), [items]);
  const badges = useMemo(() => bestForBadges(rows, items.length), [rows, items.length]);
  const profiles = useMemo(
    () => items.map((i) => buildElevationProfile(i.route.path, i.route.pathElevations)),
    [items]
  );
  const drawable = profiles.filter((p): p is ElevationProfile => p !== null);
  const scale = drawable.length > 0 ? sharedScale(drawable) : null;
  const cols = `minmax(9rem, 11rem) repeat(${items.length}, minmax(12rem, 1fr))`;

  return (
    <div className="absolute inset-0 z-30 overflow-auto bg-white p-5 text-slate-900" data-testid="route-compare">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Compare routes</h2>
          <p className="text-xs text-slate-500">
            ★ marks the best value in each row. Every elevation chart uses the same scale, so hills
            compare fairly. There is no single &ldquo;best&rdquo; route: pick on what matters to you.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comparison"
          className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Close
        </button>
      </div>

      {scale && (
        <section className="mb-5 rounded-lg border border-slate-200 p-3" data-testid="compare-overlay">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="font-semibold">Elevation, all routes</span>
            <span className="flex flex-wrap gap-3">
              {items.map((it) => (
                <span key={it.kind} className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-4 rounded" style={{ background: ROUTE_COLOR_BY_KIND[it.kind] }} />
                  {it.description.title}
                </span>
              ))}
            </span>
          </div>
          <div className="flex gap-2">
            <div className="flex flex-col justify-between py-1 text-right text-[10px] tabular-nums text-slate-500">
              <span>{Math.round(scale.maxElev * FT)} ft</span>
              <span>{Math.round(scale.minElev * FT)} ft</span>
            </div>
            <div className="min-w-0 flex-1">
              <svg
                viewBox={`0 0 ${OVERLAY_W} ${OVERLAY_H}`}
                preserveAspectRatio="none"
                className="block h-[150px] w-full rounded bg-slate-50"
                aria-hidden
              >
                {profiles.map((p, i) =>
                  p ? (
                    <path
                      key={items[i].kind}
                      d={profilePath(p, scale, OVERLAY_W, OVERLAY_H, false)}
                      fill="none"
                      stroke={ROUTE_COLOR_BY_KIND[items[i].kind]}
                      strokeWidth={2.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null
                )}
              </svg>
              <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-slate-500">
                <span>0 mi</span>
                <span>{(scale.maxMeters / MI).toFixed(1)} mi</span>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-x-3 text-xs" style={{ gridTemplateColumns: cols }} role="table" aria-label="Route comparison">
        {/* Header: name, colour, badges */}
        <div role="columnheader" />
        {items.map((it, i) => (
          <div key={it.kind} role="columnheader" className="flex flex-col gap-1 border-t-4 pb-2 pt-1.5" style={{ borderColor: ROUTE_COLOR_BY_KIND[it.kind] }}>
            <span className="text-sm font-semibold">{it.description.title}</span>
            <span className="flex flex-wrap gap-1">
              {badges[i].map((b) => (
                <span key={b} className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                  Best: {b}
                </span>
              ))}
            </span>
          </div>
        ))}

        {/* Elevation chart per route, shared scale */}
        <div role="rowheader" className="py-2 font-medium text-slate-600">
          Elevation
        </div>
        {items.map((it, i) => (
          <div key={it.kind} role="cell" className="py-2">
            {profiles[i] && scale ? (
              <ProfileChart
                profile={profiles[i]!}
                width={200}
                height={64}
                scale={scale}
                fill={`${ROUTE_COLOR_BY_KIND[it.kind]}99`}
              />
            ) : (
              <span className="text-slate-400">No elevation data</span>
            )}
            <span className="mt-0.5 block text-[11px] tabular-nums text-slate-500">
              ▲ {Math.round(Math.round(it.route.elevationGainMeters) * FT)} ft · ▼{" "}
              {Math.round(Math.round(it.route.elevationLossMeters) * FT)} ft
            </span>
          </div>
        ))}

        {/* Stat rows */}
        {rows.map((row) => [
          <div key={`${row.label}-h`} role="rowheader" className="border-t border-slate-100 py-1.5 font-medium text-slate-600">
            {row.label}
          </div>,
          ...row.values.map((v, i) => {
            const best = row.best.includes(i);
            return (
              <div
                key={`${row.label}-${items[i].kind}`}
                role="cell"
                data-best={best || undefined}
                className={`border-t border-slate-100 px-1.5 py-1.5 tabular-nums ${best ? "rounded bg-emerald-50 font-semibold text-emerald-800" : ""}`}
              >
                {best && "★ "}
                {v}
              </div>
            );
          }),
        ])}

        {/* What each route did */}
        <div role="rowheader" className="border-t border-slate-100 py-2 font-medium text-slate-600">
          What it does
        </div>
        {items.map((it) => (
          <div key={it.kind} role="cell" className="border-t border-slate-100 py-2">
            <RouteChoiceList description={it.description} />
          </div>
        ))}

        <div />
        {items.map((it) => (
          <div key={it.kind} className="pt-2">
            <button
              type="button"
              onClick={() => onSelect(it.kind)}
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Select {it.description.title}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
