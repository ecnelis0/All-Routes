"use client";

import { sampleElevation, type ElevationProfile } from "@/lib/tour/elevationProfile";
import ProfileChart from "@/components/ProfileChart";

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
  const s = sampleElevation(profile, meters);


  const total = profile.gainTo[profile.gainTo.length - 1];
  const totalDrop = profile.lossTo[profile.lossTo.length - 1];
  const g = s.gradePercent;
  const arrow = Math.abs(g) < 0.5 ? "→" : g > 0 ? "▲" : "▼";

  return (
    <div
      className="pointer-events-none absolute bottom-28 left-4 w-[17rem] rounded-lg border border-white/10 bg-slate-950/75 px-3 py-2 text-white shadow-xl backdrop-blur"
      data-testid="elevation-panel"
    >
      {/* The slope and the change coming up are what a rider feels; the
          height above sea level is context, so it is the smallest line. */}
      <div className="flex items-baseline justify-between">
        <span className="text-xl font-bold tabular-nums" style={{ color: gradeColor(g) }} data-testid="elevation-grade">
          {arrow} {Math.abs(g).toFixed(1)}%
          <span className="ml-1 text-sm font-semibold">({Math.abs(s.gradeDegrees).toFixed(1)}°)</span>
        </span>
        <span className="text-[11px] text-slate-400">slope here</span>
      </div>
      <div className="flex items-baseline justify-between text-sm tabular-nums" data-testid="elevation-ahead">
        <span className="font-semibold">
          ▲ {ft(s.aheadUp)} ft · ▼ {ft(s.aheadDown)} ft
        </span>
        <span className="text-[11px] text-slate-400">next {(s.aheadMeters / 1609.34).toFixed(1)} mi</span>
      </div>
      <div className="text-[11px] tabular-nums text-slate-400" data-testid="elevation-now">
        Elevation {Math.round(s.elevation * FT)} ft
      </div>
      <div className="mt-1">
        <ProfileChart profile={profile} width={W} height={H} progressMeters={meters} />
      </div>
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
