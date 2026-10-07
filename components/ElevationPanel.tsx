"use client";

import { useId, useMemo } from "react";
import { sampleElevation, type ElevationProfile } from "@/lib/tour/elevationProfile";

/**
 * Live elevation readout for the 3D tour: height here, the grade right
 * now (up or down), climbed and dropped so far, and the whole route's
 * profile with the rider's position on it.
 *
 * Deliberately not faded with the tour controls - elevation is part of
 * what the tour is showing, like the street name.
 */

const FT = 3.281;
/**
 * Metres -> feet exactly as the sidebar does it (round to whole metres
 * first). Converting unrounded metres put the tour's final total 1 ft off
 * the sidebar's (487 vs 486), which reads as the two disagreeing.
 */
const ft = (m: number) => Math.round(Math.round(m) * FT);
const W = 240;
const H = 52;

function gradeColor(g: number): string {
  const a = Math.abs(g);
  if (a < 3) return "#4ade80"; // flat enough not to notice
  if (a < 8) return "#fbbf24"; // a real incline
  return "#f87171"; // steep - where many riders walk or ride the brakes
}

export default function ElevationPanel({ profile, meters }: { profile: ElevationProfile; meters: number }) {
  const clipId = useId();
  const s = sampleElevation(profile, meters);
  const range = Math.max(1, profile.maxElev - profile.minElev);
  const x = (m: number) => (m / Math.max(1, profile.totalMeters)) * W;
  const y = (e: number) => H - 2 - ((e - profile.minElev) / range) * (H - 6);

  // The profile shape is fixed for the route; only the marker moves.
  const area = useMemo(() => {
    const pts = profile.cum.map((c, i) => `${x(c).toFixed(1)},${y(profile.elev[i]).toFixed(1)}`);
    return `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const total = profile.gainTo[profile.gainTo.length - 1];
  const totalDrop = profile.lossTo[profile.lossTo.length - 1];
  const g = s.gradePercent;
  const arrow = Math.abs(g) < 0.5 ? "→" : g > 0 ? "▲" : "▼";

  return (
    <div
      className="pointer-events-none absolute bottom-28 left-4 w-[17rem] rounded-lg border border-white/10 bg-slate-950/75 px-3 py-2 text-white shadow-xl backdrop-blur"
      data-testid="elevation-panel"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold tabular-nums" data-testid="elevation-now">
          {Math.round(s.elevation * FT)} ft
        </span>
        <span className="text-sm font-semibold tabular-nums" style={{ color: gradeColor(g) }} data-testid="elevation-grade">
          {arrow} {Math.abs(g).toFixed(1)}%
        </span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mt-1 block" aria-hidden>
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={x(meters)} height={H} />
          </clipPath>
        </defs>
        <path d={area} fill="rgba(148,163,184,0.25)" />
        <path d={area} fill="rgba(56,189,248,0.55)" clipPath={`url(#${clipId})`} />
        <line x1={x(meters)} x2={x(meters)} y1={0} y2={H} stroke="white" strokeOpacity={0.5} />
        <circle cx={x(meters)} cy={y(s.elevation)} r={3.5} fill="white" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-slate-300">
        <span data-testid="elevation-gained">
          ▲ {ft(s.gained)} <span className="text-slate-500">/ {ft(total)} ft</span>
        </span>
        <span data-testid="elevation-dropped">
          ▼ {ft(s.dropped)} <span className="text-slate-500">/ {ft(totalDrop)} ft</span>
        </span>
      </div>
    </div>
  );
}
