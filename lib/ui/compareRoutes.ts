/**
 * Side-by-side comparison of every route on offer: one row per statistic,
 * the best value in each row marked, and "best for ..." badges.
 *
 * There is deliberately no single "optimal" winner. Optimal depends on
 * what the rider weighs - a flat route and a short one are often different
 * routes - so the comparison says which route wins on what and leaves the
 * call to the rider.
 */

export interface ComparableRoute {
  distanceMeters: number;
  meanDanger: number;
  maxDanger: number;
  protectedLaneFraction: number;
  trafficSignals: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  maxGradePercent: number;
  maxDownGradePercent: number;
  metersInFlaggedAreas: number;
}

export interface CompareRow {
  label: string;
  /** Display text per route, in input order. */
  values: string[];
  /** Indices of the routes that win this row (ties share it). Empty if all equal. */
  best: number[];
}

type Better = "lower" | "higher";

const MI = 1609.34;
const FT = 3.281;
const ft = (m: number) => Math.round(Math.round(m) * FT);

const ROWS: {
  label: string;
  value: (r: ComparableRoute) => number;
  format: (v: number, r: ComparableRoute) => string;
  better: Better;
}[] = [
  { label: "Distance", value: (r) => r.distanceMeters, format: (v) => `${(v / MI).toFixed(1)} mi`, better: "lower" },
  { label: "Danger (avg)", value: (r) => r.meanDanger, format: (v) => v.toFixed(1), better: "lower" },
  { label: "Worst street", value: (r) => r.maxDanger, format: (v) => v.toFixed(0), better: "lower" },
  { label: "On protected lanes", value: (r) => r.protectedLaneFraction, format: (v) => `${Math.round(v * 100)}%`, better: "higher" },
  { label: "Traffic lights", value: (r) => r.trafficSignals, format: (v) => String(v), better: "lower" },
  { label: "Climbed", value: (r) => r.elevationGainMeters, format: (v) => `▲ ${ft(v)} ft`, better: "lower" },
  { label: "Dropped", value: (r) => r.elevationLossMeters, format: (v) => `▼ ${ft(v)} ft`, better: "lower" },
  {
    label: "Total elevation change",
    value: (r) => r.elevationGainMeters + r.elevationLossMeters,
    format: (v) => `${ft(v)} ft`,
    better: "lower",
  },
  { label: "Steepest climb", value: (r) => r.maxGradePercent, format: (v) => `${v}%`, better: "lower" },
  { label: "Steepest descent", value: (r) => r.maxDownGradePercent, format: (v) => `${v}%`, better: "lower" },
  {
    label: "Inside flagged areas",
    value: (r) => r.metersInFlaggedAreas,
    format: (v) => `${(v / MI).toFixed(1)} mi`,
    better: "lower",
  },
];

/** Rows compare on what is DISPLAYED, so a "win" is never invisible rounding. */
function winners(values: number[], display: string[], better: Better): number[] {
  if (new Set(display).size <= 1) return [];
  const target = better === "lower" ? Math.min(...values) : Math.max(...values);
  const shown = display[values.indexOf(target)];
  return display.flatMap((d, i) => (d === shown ? [i] : []));
}

export function compareRoutes(routes: ComparableRoute[]): CompareRow[] {
  return ROWS.map((row) => {
    const values = routes.map(row.value);
    const display = routes.map((r, i) => row.format(values[i], r));
    return { label: row.label, values: display, best: winners(values, display, row.better) };
  });
}

const BADGES: { label: string; row: string }[] = [
  { label: "Shortest", row: "Distance" },
  { label: "Safest", row: "Danger (avg)" },
  { label: "Most protected", row: "On protected lanes" },
  { label: "Flattest", row: "Total elevation change" },
  { label: "Fewest lights", row: "Traffic lights" },
];

/** "Best for" badges per route, in input order. A badge shared by every route is not shown. */
export function bestForBadges(rows: CompareRow[], count: number): string[][] {
  const out: string[][] = Array.from({ length: count }, () => []);
  for (const b of BADGES) {
    const row = rows.find((r) => r.label === b.row);
    if (!row || row.best.length === 0 || row.best.length === count) continue;
    for (const i of row.best) out[i].push(b.label);
  }
  return out;
}
