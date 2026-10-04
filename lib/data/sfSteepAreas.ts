import type { LatLng } from "../types";

/**
 * Places in San Francisco known for punishing climbs, as supplied by the
 * project owner, used by the "avoid elevation" option.
 *
 * HOW THIS IS USED, which matters more than the list itself. Grade comes
 * from real terrain (per-node DEM elevation, see
 * scripts/fetchSfElevation.mjs) and that alone drives the climbing
 * penalty everywhere in the city. This list only ADDS severity on top -
 * and only where the terrain confirms the grade is actually there.
 *
 * That restriction exists because a street name is the wrong unit for
 * steepness. Checked against the DEM, 24th Street has a 1.5% median grade
 * and only 24% of it is steep: it is a wall through Noe Valley and dead
 * flat through the Mission, where it is a major bike corridor. Broadway is
 * steep for 23% of its length, 22nd Street for 27%. Penalising those by
 * name would push riders off the flat stretches they should be using.
 *
 * Validation of the listed streets against terrain (median / max grade,
 * share of length over 8%):
 *   Bradford 18.7/23.7% 100%   Nevada   12.6/30.7%  96%
 *   Filbert   5.8/30.4%  33%   22nd      3.1/28.2%  27%
 *   Jones     7.5/27.5%  47%   Broadway  4.0/29.6%  23%
 *   Portola   4.6/ 8.5%   2%   (listed High; the terrain finds it gentle)
 * Controls: Valencia 0.9% median, 0% steep. Romolo Street is a stair
 * alley and is not in the bike graph at all.
 *
 * Area circles are approximate centroids with a radius covering the
 * hill; "Upper Mission" in particular has no fixed boundary and is placed
 * at the southern Mission toward Glen Park.
 */

export type SteepSeverity = "Moderate" | "High" | "Severe" | "Extreme";

/** Extra cost multiplier on a climbing edge, by severity. */
export const SEVERITY_MULTIPLIER: Record<SteepSeverity, number> = {
  Moderate: 1.25,
  High: 1.6,
  Severe: 2.1,
  Extreme: 3,
};

export interface SteepArea {
  name: string;
  center: LatLng;
  radiusMeters: number;
  severity: SteepSeverity;
}

export const SF_STEEP_AREAS: SteepArea[] = [
  { name: "Bernal Heights", center: { lat: 37.743, lng: -122.415 }, radiusMeters: 700, severity: "Severe" },
  { name: "Russian Hill", center: { lat: 37.801, lng: -122.419 }, radiusMeters: 550, severity: "Severe" },
  { name: "Nob Hill", center: { lat: 37.793, lng: -122.416 }, radiusMeters: 450, severity: "Severe" },
  { name: "Telegraph Hill", center: { lat: 37.8025, lng: -122.4058 }, radiusMeters: 400, severity: "Severe" },
  { name: "Pacific Heights", center: { lat: 37.7925, lng: -122.435 }, radiusMeters: 700, severity: "Severe" },
  { name: "Potrero Hill", center: { lat: 37.7576, lng: -122.4004 }, radiusMeters: 650, severity: "Severe" },
  { name: "Twin Peaks", center: { lat: 37.7544, lng: -122.4477 }, radiusMeters: 600, severity: "Severe" },
  { name: "Forest Knolls", center: { lat: 37.758, lng: -122.458 }, radiusMeters: 400, severity: "Severe" },
  { name: "Diamond Heights", center: { lat: 37.744, lng: -122.442 }, radiusMeters: 550, severity: "Severe" },
  { name: "Noe Valley", center: { lat: 37.7502, lng: -122.4337 }, radiusMeters: 700, severity: "High" },
  { name: "Upper Mission", center: { lat: 37.74, lng: -122.423 }, radiusMeters: 600, severity: "High" },
  { name: "Glen Park", center: { lat: 37.734, lng: -122.434 }, radiusMeters: 550, severity: "High" },
  { name: "Mount Davidson", center: { lat: 37.738, lng: -122.454 }, radiusMeters: 450, severity: "High" },
  { name: "McLaren Park", center: { lat: 37.718, lng: -122.419 }, radiusMeters: 750, severity: "High" },
  { name: "Excelsior", center: { lat: 37.7244, lng: -122.4267 }, radiusMeters: 800, severity: "High" },
  { name: "Mount Sutro", center: { lat: 37.759, lng: -122.458 }, radiusMeters: 450, severity: "High" },
  { name: "Presidio", center: { lat: 37.7989, lng: -122.4662 }, radiusMeters: 1400, severity: "Moderate" },
  { name: "Inner Sunset", center: { lat: 37.762, lng: -122.466 }, radiusMeters: 600, severity: "Moderate" },
];

/**
 * Listed streets. Matched against OSM names, so these use OSM's spelling
 * ("John F Shelley Drive", without the stop).
 */
export const SF_STEEP_STREETS: Record<string, SteepSeverity> = {
  "Bradford Street": "Extreme",
  "Prentiss Street": "Extreme",
  "Nevada Street": "Extreme",
  "Ripley Street": "Extreme",
  "Filbert Street": "Extreme",
  "Romolo Street": "Extreme",
  "22nd Street": "Extreme",
  "24th Street": "Extreme",
  Broadway: "Severe",
  "Hyde Street": "Severe",
  "Jones Street": "Severe",
  "Vallejo Street": "Severe",
  "Vermont Street": "Severe",
  "Connecticut Street": "Severe",
  "Clarendon Avenue": "High",
  "Twin Peaks Boulevard": "High",
  "Portola Drive": "High",
  "Mansell Street": "High",
  "John F Shelley Drive": "High",
};

/**
 * Below this grade a block is not treated as steep for the list's
 * purposes, however it is named. Chosen so that the flat Mission stretch
 * of 24th Street (around 1-2%) is never penalised while its Noe Valley
 * climb (12-25%) always is.
 */
export const STEEP_GRADE_THRESHOLD = 0.06;
