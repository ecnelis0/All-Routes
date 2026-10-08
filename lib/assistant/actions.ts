import type { InterestId } from "../interests/catalog";
import type { LatLng } from "../types";

/**
 * What the AI assistant may change - and nothing else. Each action maps to
 * a control the rider could also use by hand, and goes through the same
 * planner, so the assistant can never bypass a safety rule (it cannot, for
 * example, route through a Severe area: no action does that).
 */
export type RouteOption = "fastest" | "balanced" | "safest" | "interest";

export type AssistantAction =
  | { type: "set_trip"; from?: { label: string; point: LatLng }; to?: { label: string; point: LatLng } }
  | { type: "set_settings"; avoidHills?: boolean; fewerLights?: boolean }
  | { type: "set_interests"; interests: InterestId[] }
  | { type: "choose_route"; option: RouteOption }
  | { type: "add_stop"; label: string; point: LatLng }
  | { type: "show_places"; on: boolean };

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
      case "show_places":
        return a.on ? "Showing places along the way" : "Hiding places";
    }
  });
}
