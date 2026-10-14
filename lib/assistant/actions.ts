import type { InterestId } from "../interests/catalog";
import type { LatLng } from "../types";

/**
 * What the AI assistant may change - and nothing else. Each action maps to
 * a control the rider could also use by hand, and goes through the same
 * planner, so the assistant can never bypass a safety rule (it cannot, for
 * example, route through a Severe area: no action does that).
 */
export type RouteOption = "fastest" | "balanced" | "safest" | "interest";
export type ImproveGoal = "faster" | "flatter" | "safer" | "fewer-lights";

export type AssistantAction =
  | { type: "set_trip"; from?: { label: string; point: LatLng }; to?: { label: string; point: LatLng } }
  | { type: "set_settings"; avoidHills?: boolean; fewerLights?: boolean }
  | { type: "set_interests"; interests: InterestId[] }
  | { type: "choose_route"; option: RouteOption }
  | { type: "add_stop"; label: string; point: LatLng }
  /** My route: drop stop N (1-based, in riding order). */
  | { type: "remove_stop"; stop: number }
  /** My route: apply the best suggested edit of this kind. */
  | { type: "improve_route"; goal: ImproveGoal }
  | { type: "show_places"; on: boolean }
  /**
   * "For you": one ride built from everything the rider asked for at once -
   * which rules to ride by, hills, lights, and the places to pass. It has
   * its own settings and is planned on its own, so it changes neither the
   * other options nor the sidebar's settings.
   */
  | {
      type: "for_you_route";
      basedOn: ForYouBase;
      avoidHills: boolean;
      fewerLights: boolean;
      stops: ForYouStop[];
    };

/** Which option's rules a customized "For you" ride follows. */
export type ForYouBase = "fastest" | "balanced" | "safest";
export interface ForYouStop {
  name: string;
  emoji: string;
  point: LatLng;
}

/** What the assistant is told about the screen, so it can answer "why" questions. */
export interface AssistantContext {
  from: string | null;
  to: string | null;
  settings: { avoidHills: boolean; fewerLights: boolean };
  interests: InterestId[];
  /** One line per route currently offered, e.g. "Safest: 6.5 mi, ~57 min, danger 42". */
  routes: string[];
  /** The route being looked at: its name and what it did (the ✓/✕ list). */
  selected: { label: string; facts: string[] } | null;
  /**
   * The rider's own route, once they confirmed one. From then on changes
   * EDIT this route (its stops, its settings) instead of re-planning the
   * options - the options were only ways to choose it.
   */
  myRoute: { label: string; stops: number; avoidsHills: boolean; fewerLights: boolean; summary: string } | null;
  /** The customized "For you" ride, if the assistant has built one - so a follow-up can restate it with a change. */
  forYou?: { basedOn: ForYouBase; avoidsHills: boolean; fewerLights: boolean; stops: string[] } | null;
  /** Where the trip starts and ends, for finding places "on the way". Not shown to the model. */
  points?: { origin: LatLng; destination: LatLng } | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** One-line summary of what a reply changed, for the chat bubble. */
export function describeActions(actions: AssistantAction[]): string[] {
  return actions.map((a) => {
    switch (a.type) {
      case "set_trip":
        return [a.from && `From ${a.from.label.split(",")[0]}`, a.to && `To ${a.to.label.split(",")[0]}`]
          .filter(Boolean)
          .join(" · ");
      case "set_settings":
        return [
          a.avoidHills !== undefined && `Avoid hills ${a.avoidHills ? "on" : "off"}`,
          a.fewerLights !== undefined && `Fewer lights ${a.fewerLights ? "on" : "off"}`,
        ]
          .filter(Boolean)
          .join(" · ");
      case "set_interests":
        return a.interests.length ? `Interests: ${a.interests.join(", ")}` : "Interests cleared";
      case "choose_route":
        return `Showing ${{ fastest: "Fastest", balanced: "Safest", safest: "Safest + bike lanes", interest: "For you" }[a.option]}`;
      case "add_stop":
        return `Added stop: ${a.label.split(",")[0]}`;
      case "remove_stop":
        return `Removed stop ${a.stop}`;
      case "improve_route":
        return `Looking for a ${{ faster: "faster", flatter: "flatter", safer: "safer", "fewer-lights": "fewer-lights" }[a.goal]} change to your route`;
      case "show_places":
        return a.on ? "Showing places along the way" : "Hiding places";
      case "for_you_route":
        return [
          `For you: ${{ fastest: "Fastest", balanced: "Safest", safest: "Safest + bike lanes" }[a.basedOn]} rules`,
          a.avoidHills && "avoids hills",
          a.fewerLights && "fewer lights",
          a.stops.length > 0 && `via ${a.stops.map((s) => s.name).join(", ")}`,
        ]
          .filter(Boolean)
          .join(" · ");
    }
  });
}
