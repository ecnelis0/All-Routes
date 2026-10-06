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
}

export interface RouteDescription {
  title: string;
  /** "What this route did" - one short phrase each. */
  choices: { text: string; honoured: boolean }[];
  /** Headline numbers. */
  stats: string[];
}

const MI = 1609.34;

export function describeRoute(route: DescribableRoute, minutes: string): RouteDescription {
  const bestEffort = route.label.endsWith("best effort");
  const choices: RouteDescription["choices"] = [];

  if (route.profile === "fastest") {
    choices.push({ text: "Did not avoid dangerous areas", honoured: false });
  } else if (bestEffort || route.metersInFlaggedAreas > 0) {
    choices.push({
      text: `Could not fully avoid dangerous areas (${(route.metersInFlaggedAreas / MI).toFixed(1)} mi inside)`,
      honoured: false,
    });
  } else {
    choices.push({ text: "Avoided all flagged dangerous areas", honoured: true });
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
      `${Math.round(route.elevationGainMeters * 3.281)} ft of climbing`,
    ],
  };
}
