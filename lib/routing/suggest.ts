import {
  areaTier,
  CLIMB_FLAT_EQUIVALENT_M,
  CRUISE_MPS,
  edgeEntersSignal,
  SIGNAL_WAIT_SECONDS,
  exemptAreaBits,
  exemptHotspots,
  getRoutingEngine,
  MAX_CUSTOM_WAYPOINTS,
  planCustomPath,
  routePathFromLatLngs,
  summarizeCustom,
  type CustomPlan,
  type PlanOptions,
  type RouteSummary,
} from "./service";
import type { RouteProfile } from "./cost";
import type { RoutePath } from "./astar";
import type { GraphEdge } from "./graph";
import { SF_DANGEROUS_NEIGHBORHOODS } from "../data/sfDangerousNeighborhoods";
import { alongPath, distanceToPath } from "../ui/geometry";
import type { LatLng } from "../types";

/**
 * SUGGESTED EDITS: local trade-offs on the rider's route.
 *
 * The route the rider has (profile P, hill/light settings O, their stops)
 * is re-planned under every OTHER combination of profile and settings,
 * through the same stops. Wherever an alternative leaves the route and
 * rejoins it, that stretch is a candidate edit, and its exact trade-off is
 * measured against the stretch it would replace: minutes, climbing,
 * danger, traffic lights, flagged areas.
 *
 * Only real improvements survive ("save 4 min via Castro Street - costs
 * +120 ft climbing"). Stretches are compared, not whole routes, so each
 * suggestion is a small, understandable change the rider can take or
 * leave, and accepting one never silently changes the rest of the route.
 *
 * Severe areas are the owner's hard rule: a suggestion never enters one
 * (unless the trip starts or ends there), whatever time it would save.
 */

/** Same time model as every time shown in the app (see estimateSeconds). */
export const CYCLING_MPS = CRUISE_MPS;
/** A suggestion may cost at most this much extra time for a non-time benefit. */
export const MAX_ADDED_MINUTES = 5;
/** At most this many suggestions - more is noise, not help. */
export const MAX_SUGGESTIONS = 6;

export type SuggestionKind = "faster" | "flatter" | "safer" | "fewer-lights";

export interface SuggestedEdit {
  id: string;
  kind: SuggestionKind;
  /** e.g. "Save 4 min via Castro Street" */
  headline: string;
  gains: string[];
  /** Empty when the alternative is simply better. */
  costs: string[];
  /** Where to show the checkpoint: the point of the alternative farthest from the current route. */
  checkpoint: LatLng;
  /** The alternative stretch, and the stretch of the current route it replaces. */
  sectionPath: LatLng[];
  replacedPath: LatLng[];
  /** The whole route with this edit applied. */
  route: RouteSummary;
}

interface SectionStats {
  meters: number;
  climb: number;
  dangerMeters: number;
  lights: number;
  /** Flagged areas the stretch rides through, metres per area index. */
  areas: Map<number, number>;
  /** Crash hotspots the stretch rides through (not counting endpoint ones). */
  hotspots: Set<number>;
  /** Metres descended, and the steepest block either way (as a fraction). */
  drop: number;
  steepest: number;
}

function sectionStats(edges: GraphEdge[], exempt: number, hotExempt: Set<number> = new Set()): SectionStats {
  const eng = getRoutingEngine();
  const st: SectionStats = {
    meters: 0,
    climb: 0,
    dangerMeters: 0,
    lights: 0,
    areas: new Map(),
    hotspots: new Set(),
    drop: 0,
    steepest: 0,
  };
  for (const e of edges) {
    st.meters += e.lengthMeters;
    st.climb += Math.max(0, eng.climbMeters[e.id]);
    st.drop += Math.max(0, -eng.climbMeters[e.id]);
    // Short fragments are DEM noise, as everywhere else grades are read.
    if (e.lengthMeters >= 25) st.steepest = Math.max(st.steepest, Math.abs(eng.climbMeters[e.id]) / e.lengthMeters);
    st.dangerMeters += eng.scores[e.id] * e.lengthMeters;
    if (edgeEntersSignal(eng, e.id)) st.lights++;
    const h = eng.edgeHotspot[e.id];
    if (h >= 0 && !hotExempt.has(h)) st.hotspots.add(h);
    let mask = eng.areaMask[e.id] & ~exempt;
    for (let i = 0; mask; i++, mask >>>= 1) {
      if (mask & 1) st.areas.set(i, (st.areas.get(i) ?? 0) + e.lengthMeters);
    }
  }
  return st;
}

const mean = (s: SectionStats) => (s.meters > 0 ? s.dangerMeters / s.meters : 0);
const ft = (m: number) => Math.round(m * 3.281);

/** Node sequence of a path. */
function nodesOf(p: RoutePath): number[] {
  return p.edges.length ? [p.edges[0].from, ...p.edges.map((e) => e.to)] : [];
}

export interface Divergence {
  /** Node indices into the base sequence: the stretch base[bs..be] is replaced... */
  bs: number;
  be: number;
  /** ...by candidate[cs..ce]. Both start and end on shared nodes. */
  cs: number;
  ce: number;
}

/**
 * Stretches where `cand` leaves `base` and later rejoins it further along.
 * A rejoin must be AHEAD of the departure on the base route, so a splice
 * never sends the rider backwards.
 */
export function divergences(base: number[], cand: number[]): Divergence[] {
  const posB = new Map<number, number>();
  base.forEach((n, i) => {
    if (!posB.has(n)) posB.set(n, i);
  });
  const out: Divergence[] = [];
  let i = 0;
  while (i < cand.length - 1) {
    const a = posB.get(cand[i]);
    const b = posB.get(cand[i + 1]);
    if (a !== undefined && b === a + 1) {
      i++; // riding the same edge as the base route
      continue;
    }
    if (a === undefined) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < cand.length) {
      const k = posB.get(cand[j]);
      if (k !== undefined && k > a) break;
      j++;
    }
    if (j >= cand.length) break;
    out.push({ bs: a, be: posB.get(cand[j])!, cs: i, ce: j });
    i = j;
  }
  return out;
}

/** The base route with base[bs..be] replaced by cand[cs..ce]. */
export function splice(base: RoutePath, cand: RoutePath, d: Divergence): RoutePath {
  const eng = getRoutingEngine();
  const edges = [...base.edges.slice(0, d.bs), ...cand.edges.slice(d.cs, d.ce), ...base.edges.slice(d.be)];
  const nodes = [edges[0].from, ...edges.map((e) => e.to)];
  return {
    edges,
    path: nodes.map((n) => eng.graph.nodes[n]),
    distanceMeters: edges.reduce((t, e) => t + e.lengthMeters, 0),
    costMeters: 0,
  };
}

/** The one or two streets that make the alternative stretch different. */
function viaStreets(cand: GraphEdge[], base: GraphEdge[]): string {
  const baseNames = new Set(base.map((e) => e.name));
  const byName = new Map<string, number>();
  for (const e of cand) {
    if (!e.name || baseNames.has(e.name)) continue;
    byName.set(e.name, (byName.get(e.name) ?? 0) + e.lengthMeters);
  }
  const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
  return top.length ? `via ${top.join(" and ")}` : "on a different line";
}

interface Scored {
  kind: SuggestionKind;
  score: number;
  headline: string;
  gains: string[];
  costs: string[];
}

/**
 * Judges one stretch swap. Null unless it genuinely improves something.
 * Thresholds keep out noise: a few seconds or a few feet are not worth a
 * rider's attention.
 */
export function judge(base: SectionStats, cand: SectionStats, via: string): Scored | null {
  // Same model as the route totals, so "save 8 min" adds up with them.
  const minutes =
    ((cand.meters - base.meters + CLIMB_FLAT_EQUIVALENT_M * (cand.climb - base.climb)) / CRUISE_MPS +
      SIGNAL_WAIT_SECONDS * (cand.lights - base.lights)) /
    60;
  const climb = cand.climb - base.climb;
  const mb = mean(base);
  const mc = mean(cand);
  const lights = cand.lights - base.lights;

  const benefits: { kind: SuggestionKind; score: number; text: string }[] = [];
  if (minutes <= -1) benefits.push({ kind: "faster", score: -minutes / 2, text: `saves ${Math.round(-minutes)} min` });
  if (climb <= -15) benefits.push({ kind: "flatter", score: -climb / 30, text: `${ft(-climb)} ft less climbing` });
  if (mc <= mb - 8 && cand.meters >= 200)
    benefits.push({ kind: "safer", score: (mb - mc) / 10, text: `quieter streets (danger ${Math.round(mb)} → ${Math.round(mc)})` });
  if (lights <= -2) benefits.push({ kind: "fewer-lights", score: -lights / 3, text: `${-lights} fewer traffic lights` });
  if (benefits.length === 0) return null;
  // A suggestion is a small change to the route. Quieter streets that add
  // 13 minutes are a different route, not an edit (seen in testing).
  if (minutes > MAX_ADDED_MINUTES) return null;

  const costs: string[] = [];
  if (minutes >= 0.5) costs.push(`+${Math.round(minutes * 10) / 10} min`);
  if (climb >= 8) costs.push(`+${ft(climb)} ft climbing`);
  // Steep DOWNHILL is a cost too (braking, speed) - without these, "Save 8
  // min via Steiner Street - no downside" hid Steiner's steep blocks.
  if (cand.drop - base.drop >= 8) costs.push(`+${ft(cand.drop - base.drop)} ft downhill`);
  if (cand.steepest >= 0.08 && cand.steepest > base.steepest + 0.03) {
    costs.push(`steeper blocks (up to ${Math.round(cand.steepest * 100)}%)`);
  }
  if (mc >= mb + 5) costs.push(`busier, riskier streets (danger ${Math.round(mb)} → ${Math.round(mc)})`);
  if (lights >= 1) costs.push(`+${lights} traffic light${lights === 1 ? "" : "s"}`);
  const newHotspots = [...cand.hotspots].filter((h) => !base.hotspots.has(h)).length;
  // Without this, an edit that only saved time by cutting through a crash
  // hotspot read "no downside" - which is why the router had not taken it.
  if (newHotspots > 0) costs.push(`passes through ${newHotspots} crash hotspot${newHotspots === 1 ? "" : "s"}`);
  for (const [i, meters] of cand.areas) {
    if ((base.areas.get(i) ?? 0) >= meters) continue;
    const a = SF_DANGEROUS_NEIGHBORHOODS[i];
    costs.push(`passes through ${a.name} (${areaTier(a.risk)}, ${(meters / 1609.34).toFixed(1)} mi)`);
  }

  benefits.sort((a, b) => b.score - a.score);
  const top = benefits[0];
  const lead = {
    faster: `Save ${Math.round(-minutes)} min ${via}`,
    flatter: `Skip ${ft(-climb)} ft of climbing ${via}`,
    safer: `Quieter streets ${via}`,
    "fewer-lights": `${-lights} fewer traffic lights ${via}`,
  }[top.kind];
  return {
    kind: top.kind,
    score: top.score,
    headline: costs.length ? `${lead} - costs ${costs.join(", ")}` : `${lead} - no downside`,
    gains: benefits.map((b) => b.text),
    costs,
  };
}

export function suggestEdits(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  profileId: RouteProfile["id"],
  options: PlanOptions = {},
  /** Headlines already accepted on this route - carried onto every suggestion's route. */
  accepted: string[] = [],
  /**
   * The route exactly as the rider sees it. Suggestions are measured
   * against THIS, never a re-plan: re-planning gave a different route
   * (different area handling), so "no downside" edits rewrote the whole
   * trip once applied.
   */
  basePath?: LatLng[]
): SuggestedEdit[] {
  const eng = getRoutingEngine();
  const planned: CustomPlan = planCustomPath(origin, destination, waypoints, profileId, options);
  const shown = basePath ? routePathFromLatLngs(basePath) : null;
  const base: CustomPlan = shown ? { ...planned, path: shown } : planned;
  const baseNodes = nodesOf(base.path);
  // The start/end/stop areas are unavoidable and never count against a stretch.
  const exempt = exemptAreaBits(base.stops.map((n) => eng.graph.nodes[n]));
  const hotExempt = exemptHotspots(eng, base.stops.map((n) => eng.graph.nodes[n]));
  const severeBits = SF_DANGEROUS_NEIGHBORHOODS.reduce(
    (m, a, i) => (areaTier(a.risk) === "Severe" ? m | (1 << i) : m),
    0
  );

  const found: (Scored & { d: Divergence; cand: RoutePath; signature: string })[] = [];
  for (const pid of ["fastest", "balanced", "safest"] as const) {
    for (const avoidElevation of [false, true]) {
      for (const fewerSignals of [false, true]) {
        if (
          pid === profileId &&
          avoidElevation === (options.avoidElevation ?? false) &&
          fewerSignals === (options.fewerSignals ?? false)
        ) {
          continue; // that is the route the rider already has
        }
        let cand: CustomPlan;
        try {
          cand = planCustomPath(origin, destination, waypoints, pid, { avoidElevation, fewerSignals });
        } catch {
          continue;
        }
        for (const d of divergences(baseNodes, nodesOf(cand.path))) {
          const bEdges = base.path.edges.slice(d.bs, d.be);
          const cEdges = cand.path.edges.slice(d.cs, d.ce);
          const bStats = sectionStats(bEdges, exempt, hotExempt);
          if (bStats.meters < 80 && cEdges.reduce((t, e) => t + e.lengthMeters, 0) < 80) continue;
          // The hard rule: never into a Severe area the trip does not start or end in.
          if (cEdges.some((e) => (eng.areaMask[e.id] & severeBits & ~exempt) !== 0)) continue;
          const verdict = judge(bStats, sectionStats(cEdges, exempt, hotExempt), viaStreets(cEdges, bEdges));
          if (!verdict) continue;
          found.push({ ...verdict, d, cand: cand.path, signature: cEdges.map((e) => e.id).join(",") });
        }
      }
    }
  }

  // Best first; one suggestion per distinct stretch, and per kind no two
  // that replace overlapping parts of the route.
  found.sort((a, b) => b.score - a.score);
  const kept: typeof found = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.signature)) continue;
    if (kept.some((k) => k.kind === f.kind && f.d.bs < k.d.be && k.d.bs < f.d.be)) continue;
    seen.add(f.signature);
    kept.push(f);
    if (kept.length >= MAX_SUGGESTIONS) break;
  }

  return kept.map((f, n) => {
    const spliced = splice(base.path, f.cand, f.d);
    const section = f.cand.edges.slice(f.d.cs, f.d.ce);
    const sectionPath = [eng.graph.nodes[section[0].from], ...section.map((e) => eng.graph.nodes[e.to])];
    const replaced = base.path.edges.slice(f.d.bs, f.d.be);
    const replacedPath = replaced.length
      ? [eng.graph.nodes[replaced[0].from], ...replaced.map((e) => eng.graph.nodes[e.to])]
      : [];
    // The checkpoint is where the alternative strays furthest from the
    // current route - the unmistakable "go this way" point - and becomes a
    // stop, so later edits re-plan through it rather than undoing it.
    let checkpoint = sectionPath[Math.floor(sectionPath.length / 2)];
    let far = -1;
    for (const p of sectionPath) {
      const d = distanceToPath(p, base.path.path);
      if (d > far) {
        far = d;
        checkpoint = p;
      }
    }
    const stops =
      waypoints.length < MAX_CUSTOM_WAYPOINTS
        ? [...waypoints, checkpoint].sort((a, b) => alongPath(a, spliced.path) - alongPath(b, spliced.path))
        : waypoints;
    const route = summarizeCustom(
      { path: spliced, bestEffort: base.bestEffort, stops: base.stops },
      stops,
      profileId,
      options
    );
    return {
      id: `s${n + 1}`,
      kind: f.kind,
      headline: f.headline,
      gains: f.gains,
      costs: f.costs,
      checkpoint,
      sectionPath,
      replacedPath,
      route: { ...route, acceptedSuggestions: [...accepted, f.headline] },
    };
  });
}

