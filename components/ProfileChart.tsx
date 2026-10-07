"use client";

import { useId } from "react";
import { elevationAt, type ElevationProfile } from "@/lib/tour/elevationProfile";

/**
 * The elevation profile drawing shared by the 3D tour's live panel and the
 * route comparison. `scale` lets several charts share one set of axes -
 * without it each chart stretches its own hills to fill the box, and a
 * 30 ft rise would look as tall as a 400 ft one.
 */

export interface ProfileScale {
  maxMeters: number;
  minElev: number;
  maxElev: number;
}

export function ownScale(p: ElevationProfile): ProfileScale {
  return { maxMeters: p.totalMeters, minElev: p.minElev, maxElev: p.maxElev };
}

export function sharedScale(profiles: ElevationProfile[]): ProfileScale {
  return {
    maxMeters: Math.max(...profiles.map((p) => p.totalMeters)),
    minElev: Math.min(...profiles.map((p) => p.minElev)),
    maxElev: Math.max(...profiles.map((p) => p.maxElev)),
  };
}

/** SVG path for a profile: a closed area (for fills) or an open line. */
export function profilePath(p: ElevationProfile, s: ProfileScale, w: number, h: number, closed: boolean): string {
  const range = Math.max(1, s.maxElev - s.minElev);
  const x = (m: number) => (m / Math.max(1, s.maxMeters)) * w;
  const y = (e: number) => h - 2 - ((e - s.minElev) / range) * (h - 6);
  const pts = p.cum.map((c, i) => `${x(c).toFixed(1)},${y(p.elev[i]).toFixed(1)}`);
  return closed ? `M0,${h} L${pts.join(" L")} L${x(p.totalMeters).toFixed(1)},${h} Z` : `M${pts.join(" L")}`;
}

export default function ProfileChart({
  profile,
  width,
  height,
  scale = ownScale(profile),
  fill = "rgba(56,189,248,0.55)",
  baseFill = "rgba(148,163,184,0.25)",
  progressMeters,
}: {
  profile: ElevationProfile;
  width: number;
  height: number;
  scale?: ProfileScale;
  fill?: string;
  baseFill?: string;
  /** When set, the ridden part is filled and a marker shows the rider. */
  progressMeters?: number;
}) {
  const clipId = useId();
  const area = profilePath(profile, scale, width, height, true);
  const range = Math.max(1, scale.maxElev - scale.minElev);
  const x = (m: number) => (m / Math.max(1, scale.maxMeters)) * width;
  const y = (e: number) => height - 2 - ((e - scale.minElev) / range) * (height - 6);

  if (progressMeters === undefined) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" aria-hidden>
        <path d={area} fill={fill} />
      </svg>
    );
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" aria-hidden>
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={x(progressMeters)} height={height} />
        </clipPath>
      </defs>
      <path d={area} fill={baseFill} />
      <path d={area} fill={fill} clipPath={`url(#${clipId})`} />
      <line x1={x(progressMeters)} x2={x(progressMeters)} y1={0} y2={height} stroke="white" strokeOpacity={0.5} />
      <circle cx={x(progressMeters)} cy={y(elevationAt(profile, progressMeters))} r={3.5} fill="white" />
    </svg>
  );
}
