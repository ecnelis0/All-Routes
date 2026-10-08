import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { geocode } from "../geocode";
import { INTERESTS, type InterestId } from "../interests/catalog";
import type { AssistantAction, AssistantContext, ChatMessage } from "./actions";

/**
 * The route assistant: reads what the rider asks plus what is on screen,
 * and answers with a short reply and a list of actions (lib/assistant/
 * actions.ts) for the page to apply through its normal controls.
 *
 * Tools only RECORD actions; they change nothing themselves. Place names
 * are geocoded here so the assistant can only add stops that exist, and it
 * is told the safety rules so it explains rather than promises around them.
 */

const INTEREST_IDS = INTERESTS.map((i) => i.id) as [string, ...string[]];

export function systemPrompt(ctx: AssistantContext): string {
  return [
    "You are the route assistant in a San Francisco bike-route planner.",
    "You change the plan ONLY by calling tools; then reply in one or two short sentences saying what you changed.",
    "If the rider asks something you cannot do with the tools, say so plainly.",
    "",
    "How routing works (explain, do not promise around it):",
    "- Options: Fastest (quickest ride, counting hills and red lights), Safest, Safest + bike lanes, and 'For you' (passes places the rider likes).",
    "- Safest options never enter Severe areas (Tenderloin, SoMa, Civic Center, Bayview-Hunters Point), and stay out of High/Elevated areas and crash hotspots unless that makes the trip more than 40% longer than Fastest.",
    "- 'Avoid hills' minimises elevation change; 'Fewer traffic lights' avoids signals.",
    `- Interests available: ${INTERESTS.map((i) => `${i.id} (${i.label})`).join(", ")}.`,
    "- To make the route go somewhere specific ('via Ocean Beach', 'past the Ferry Building'), use add_stop.",
    "",
    "The options and settings are ways to CHOOSE a route. Once the rider has confirmed one ('myRoute' below is not null),",
    "it is THEIR route: requests change that route. Use add_stop / remove_stop for where it goes, set_settings to re-plan",
    "it with hills/lights preferences (its stops are kept), and improve_route for 'make it faster / flatter / safer /",
    "fewer lights'. Do not change the trip (set_trip) unless the rider asks for a different start or destination.",
    "",
    "What is on screen now:",
    JSON.stringify(ctx, null, 1),
  ].join("\n");
}

export async function runAssistant(
  model: LanguageModel,
  messages: ChatMessage[],
  ctx: AssistantContext
): Promise<{ reply: string; actions: AssistantAction[] }> {
  const actions: AssistantAction[] = [];
  const findPlace = async (q: string) => {
    const [hit] = await geocode(q, 1);
    return hit ? { label: hit.label, point: { lat: hit.lat, lng: hit.lng } } : null;
  };

  const result = await generateText({
    model,
    system: systemPrompt(ctx),
    messages,
    stopWhen: isStepCount(5),
    tools: {
      set_trip: tool({
        description: "Set where the ride starts and/or ends, by place name or address in San Francisco.",
        inputSchema: z.object({
          from: z.string().optional().describe("Start, e.g. 'Marina Green'"),
          to: z.string().optional().describe("Destination, e.g. 'Ocean Beach'"),
        }),
        execute: async ({ from, to }) => {
          const a = from ? await findPlace(from) : undefined;
          const b = to ? await findPlace(to) : undefined;
          if ((from && !a) || (to && !b)) return { ok: false, error: `Could not find ${!a && from ? from : to} in San Francisco.` };
          actions.push({ type: "set_trip", from: a ?? undefined, to: b ?? undefined });
          return { ok: true, from: a?.label, to: b?.label };
        },
      }),
      set_settings: tool({
        description: "Turn 'Avoid hills' and/or 'Fewer traffic lights' on or off.",
        inputSchema: z.object({ avoidHills: z.boolean().optional(), fewerLights: z.boolean().optional() }),
        execute: async (input) => {
          actions.push({ type: "set_settings", ...input });
          return { ok: true };
        },
      }),
      set_interests: tool({
        description: "Set the rider's interests (replaces the current list). This adds a 'For you' route passing such places.",
        inputSchema: z.object({ interests: z.array(z.enum(INTEREST_IDS)) }),
        execute: async ({ interests }) => {
          actions.push({ type: "set_interests", interests: interests as InterestId[] });
          return { ok: true };
        },
      }),
      choose_route: tool({
        description: "Show one of the route options.",
        inputSchema: z.object({
          option: z.enum(["fastest", "balanced", "safest", "interest"]).describe(
            "fastest = Fastest, balanced = Safest, safest = Safest + bike lanes, interest = For you"
          ),
        }),
        execute: async ({ option }) => {
          actions.push({ type: "choose_route", option });
          return { ok: true };
        },
      }),
      add_stop: tool({
        description: "Make the route pass through a place (by name or address in San Francisco).",
        inputSchema: z.object({ place: z.string() }),
        execute: async ({ place }) => {
          const hit = await findPlace(place);
          if (!hit) return { ok: false, error: `Could not find ${place} in San Francisco.` };
          actions.push({ type: "add_stop", ...hit });
          return { ok: true, found: hit.label };
        },
      }),
      remove_stop: tool({
        description: "Remove a stop from the rider's confirmed route (My route), by its number in riding order.",
        inputSchema: z.object({ stop: z.number().int().min(1) }),
        execute: async ({ stop }) => {
          if (!ctx.myRoute) return { ok: false, error: "There is no confirmed route yet." };
          if (stop > ctx.myRoute.stops) return { ok: false, error: `My route has ${ctx.myRoute.stops} stop(s).` };
          actions.push({ type: "remove_stop", stop });
          return { ok: true };
        },
      }),
      improve_route: tool({
        description:
          "Improve the rider's confirmed route (My route) by applying the best suggested edit of one kind. The app reports the trade-off it found, or that none exists.",
        inputSchema: z.object({ goal: z.enum(["faster", "flatter", "safer", "fewer-lights"]) }),
        execute: async ({ goal }) => {
          if (!ctx.myRoute) return { ok: false, error: "There is no confirmed route yet - confirm one first." };
          actions.push({ type: "improve_route", goal });
          return { ok: true, note: "The app will apply the best such edit and show its cost, or say none exists." };
        },
      }),
      show_places: tool({
        description: "Show or hide photos of places worth stopping at along the route.",
        inputSchema: z.object({ on: z.boolean() }),
        execute: async ({ on }) => {
          actions.push({ type: "show_places", on });
          return { ok: true };
        },
      }),
    },
  });
  return { reply: result.text.trim() || "Done.", actions };
}
