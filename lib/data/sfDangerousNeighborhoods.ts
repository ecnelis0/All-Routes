import type { LatLng } from "../types";

/**
 * Neighbourhood-scale areas flagged as dangerous for cycling.
 *
 * This is a DIFFERENT GRANULARITY from `KNOWN_DANGEROUS_LOCATIONS` in
 * `lib/mockData.ts`, and both are deliberately kept. Those are
 * intersection-scale hotspots (~150m: "Turk & Taylor", "16th & Mission")
 * that model where crashes actually cluster. These are whole districts
 * (~400-1300m) that model area-level risk - the thing a rider means by
 * "don't route me through there." A route can perfectly well dodge every
 * individual hotspot and still spend twenty blocks somewhere the rider
 * did not want to be, which is exactly the gap this list closes.
 *
 * Circles are a coarse approximation of irregular neighbourhood boundaries.
 * They are what the map renders and what `neighborhoodRisk` samples, and
 * they will inevitably clip a few blocks in or out at the edges. Replacing
 * `center`/`radiusMeters` with real polygons from SF's open-data
 * neighbourhood boundaries is the natural upgrade; nothing outside this
 * file assumes the shape is a circle except the renderer.
 *
 * ON THE `risk` VALUES: these are PLACEHOLDERS, set uniformly by tier and
 * not derived from any crime or collision dataset. They encode "this area
 * was flagged" and a rough sense of extent, nothing more. Do not present
 * them to users as measured danger, and do not tune them by hand to make
 * particular routes look good - that is what training the model on real
 * data is for. Once real per-area data exists, these should be replaced
 * wholesale rather than adjusted.
 */
export interface DangerousNeighborhood {
  id: string;
  name: string;
  center: LatLng;
  /** Circular approximation of the district's extent. */
  radiusMeters: number;
  /** 0-100 placeholder risk - see the note above before trusting this. */
  risk: number;
}

// Three coarse bands rather than 17 bespoke numbers: inventing a distinct
// value per neighbourhood would imply a precision this data does not have.
const SEVERE = 85;
const HIGH = 70;
const ELEVATED = 55;

export const SF_DANGEROUS_NEIGHBORHOODS: DangerousNeighborhood[] = [
  // Dense, consistently-flagged core.
  { id: "tenderloin", name: "Tenderloin", center: { lat: 37.7840, lng: -122.4142 }, radiusMeters: 480, risk: SEVERE },
  { id: "soma", name: "SoMa (South of Market)", center: { lat: 37.7785, lng: -122.4056 }, radiusMeters: 1100, risk: SEVERE },
  { id: "civic-center", name: "Civic Center", center: { lat: 37.7793, lng: -122.4177 }, radiusMeters: 450, risk: SEVERE },
  { id: "bayview-hunters-point", name: "Bayview–Hunters Point", center: { lat: 37.7299, lng: -122.3869 }, radiusMeters: 1300, risk: SEVERE },

  // Large districts with mixed conditions.
  { id: "western-addition", name: "Western Addition", center: { lat: 37.7805, lng: -122.4324 }, radiusMeters: 700, risk: HIGH },
  { id: "fillmore", name: "Fillmore", center: { lat: 37.7840, lng: -122.4327 }, radiusMeters: 520, risk: HIGH },
  { id: "mission", name: "Mission District", center: { lat: 37.7599, lng: -122.4148 }, radiusMeters: 1000, risk: HIGH },
  { id: "visitacion-valley", name: "Visitacion Valley", center: { lat: 37.7132, lng: -122.4053 }, radiusMeters: 720, risk: HIGH },
  { id: "excelsior", name: "Excelsior", center: { lat: 37.7244, lng: -122.4267 }, radiusMeters: 820, risk: HIGH },
  { id: "outer-mission", name: "Outer Mission", center: { lat: 37.7211, lng: -122.4465 }, radiusMeters: 700, risk: HIGH },
  { id: "downtown", name: "Downtown", center: { lat: 37.7897, lng: -122.4000 }, radiusMeters: 700, risk: HIGH },
  { id: "union-square", name: "Union Square", center: { lat: 37.7880, lng: -122.4075 }, radiusMeters: 380, risk: HIGH },
  { id: "chinatown", name: "Chinatown", center: { lat: 37.7941, lng: -122.4078 }, radiusMeters: 420, risk: HIGH },

  // Flagged, but lower-density / more residential.
  { id: "potrero-hill", name: "Potrero Hill", center: { lat: 37.7576, lng: -122.4004 }, radiusMeters: 720, risk: ELEVATED },
  { id: "oceanview", name: "Oceanview", center: { lat: 37.7180, lng: -122.4569 }, radiusMeters: 640, risk: ELEVATED },
  { id: "portola", name: "Portola", center: { lat: 37.7260, lng: -122.4050 }, radiusMeters: 740, risk: ELEVATED },
  { id: "bernal-heights", name: "Bernal Heights", center: { lat: 37.7400, lng: -122.4155 }, radiusMeters: 720, risk: ELEVATED },
];

/** Colour ramp for the map, keyed off `risk`. Shared by the legend so the two cannot drift. */
export function neighborhoodRiskColor(risk: number): string {
  if (risk >= 80) return "#dc2626"; // red
  if (risk >= 65) return "#f97316"; // orange
  return "#facc15"; // amber
}

export function neighborhoodRiskLabel(risk: number): string {
  if (risk >= 80) return "Severe";
  if (risk >= 65) return "High";
  return "Elevated";
}
