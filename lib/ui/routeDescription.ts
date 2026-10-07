/**
 * What a route on the map IS, in plain words, for the popup shown when
 * the route line is clicked: which option produced it and which of the
 * rider's choices it honoured or did not.
 *
 * Every line is derived from fields the router itself reported on the
 * route (not from the current toggle state in the UI), so a route stays
 * correctly described even after the toggles have been changed.
 */

export interface DescribableRoute {
  profile: "fastest" | "balanced" | "safest";
  label: string;
  distanceMeters: number;
  metersInFlaggedAreas: number;
  protectedLaneFraction: number;
  avoidedElevation: boolean;
  preferredFewerSignals: boolean;
  trafficSignals: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  neighborhoodsEntered: {
    name: string;
    meters: number;
    tier: "Severe" | "High" | "Elevated";
    atEndpoint: boolean;
  }[];
  areaTradeoff?: { avoidAllExtraPercent: number | null; limitPercent: number } | null;
  /** Present only on a route the rider edited. */
  customWaypoints?: unknown[];
}

export interface RouteDescription {
  title: string;
  /** "What this route did" - one short phrase each. */
  choices: { text: string; honoured: boolean }[];
  /** Headline numbers. */
  stats: string[];
}

const MI = 1609.34;

/**
 * The area rules, said plainly: Severe areas are skipped whatever the
 * detour; High/Elevated ones unless staying out of all of them breaks the
 * detour limit. An area the trip starts or ends in cannot be avoided, and
 * is named as such rather than counted as a failure.
 */
function areaChoices(route: DescribableRoute): RouteDescription["choices"] {
  const fmt = (n: DescribableRoute["neighborhoodsEntered"][number]) =>
    `${n.name} (${n.tier}, ${(n.meters / MI).toFixed(1)} mi)`;
  const names = (ns: DescribableRoute["neighborhoodsEntered"]) => ns.map((n) => n.name).join(", ");
  const severe = route.neighborhoodsEntered.filter((n) => n.tier === "Severe");
  const lower = route.neighborhoodsEntered.filter((n) => n.tier !== "Severe");
  const sevThrough = severe.filter((n) => !n.atEndpoint);
  const sevEnd = severe.filter((n) => n.atEndpoint);
  const lowThrough = lower.filter((n) => !n.atEndpoint);
  const lowEnd = lower.filter((n) => n.atEndpoint);
  const out: RouteDescription["choices"] = [];

  if (sevThrough.length > 0) {
    out.push({
      text: `Went through Severe areas: ${sevThrough.map(fmt).join(", ")} - there was no other way`,
      honoured: false,
    });
  } else {
    out.push({
      text:
        sevEnd.length > 0
          ? `Avoided every Severe area, except ${names(sevEnd)} where the trip starts or ends`
          : "Avoided every Severe area",
      honoured: true,
    });
  }

  if (lowThrough.length > 0) {
    const t = route.areaTradeoff;
    const why =
      t && t.avoidAllExtraPercent !== null
        ? `staying out of all of them would make the trip ${t.avoidAllExtraPercent}% longer than Fastest (limit ${t.limitPercent}%)`
        : "no route stays out of all of them";
    out.push({ text: `Went through ${lowThrough.map(fmt).join(", ")} - ${why}`, honoured: false });
  } else {
    out.push({
      text:
        lowEnd.length > 0
          ? `Avoided every High and Elevated area, except ${names(lowEnd)} where the trip starts or ends`
          : "Avoided every High and Elevated area",
      honoured: true,
    });
  }
  return out;
}

export function describeRoute(route: DescribableRoute, minutes: string): RouteDescription {
  const choices: RouteDescription["choices"] = [];

  if (route.customWaypoints) {
    const n = route.customWaypoints.length;
    choices.push({
      text: n > 0 ? `Your edited route · passes ${n} stop${n === 1 ? "" : "s"} you chose` : "Your edited route",
      honoured: true,
    });
  }

  if (route.profile === "fastest") {
    choices.push({ text: "Did not avoid dangerous areas", honoured: false });
  } else {
    choices.push(...areaChoices(route));
  }

  if (route.profile === "safest") {
    choices.push({ text: "Kept to protected bike lanes where possible", honoured: true });
  }

  choices.push(
    route.avoidedElevation
      ? { text: "Avoided hills", honoured: true }
      : { text: "Did not avoid hills", honoured: false }
  );
  choices.push(
    route.preferredFewerSignals
      ? { text: "Avoided traffic lights", honoured: true }
      : { text: "Did not avoid traffic lights", honoured: false }
  );

  return {
    title: route.label,
    choices,
    stats: [
      `${(route.distanceMeters / MI).toFixed(1)} mi · ~${minutes} min`,
      `${Math.round(route.protectedLaneFraction * 100)}% on protected lanes`,
      `${route.trafficSignals} traffic light${route.trafficSignals === 1 ? "" : "s"}`,
      `▲ ${Math.round(route.elevationGainMeters * 3.281)} ft / ▼ ${Math.round(route.elevationLossMeters * 3.281)} ft`,
    ],
  };
}
