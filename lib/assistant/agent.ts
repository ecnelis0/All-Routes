import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { geocode } from "../geocode";
import { emojiFor, INTERESTS, type InterestId, type PlaceInterest } from "../interests/catalog";
import { nearestPlace } from "../interests/planner";
import type { LatLng } from "../types";
import type { AssistantAction, AssistantContext, ChatMessage, ForYouStop } from "./actions";

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
/** Kinds of place a stop can be - every interest that is a place (not "bike paths"). */
const PLACE_KINDS = INTERESTS.map((i) => i.id).filter((id) => id !== "bikepaths") as [string, ...string[]];
const MAX_FOR_YOU_STOPS = 8;

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
    "A ride of the rider's own, described in one go - several wishes together ('avoid hills and dangerous neighbourhoods,",
    "but still pass Chinatown for boba and food'), or 'make me a new / custom / different option' - is ONE call to",
    "make_for_you_route with everything in it. It becomes the 'For you' option, beside the others: it changes no other",
    "option and no setting, so do NOT also call set_settings, set_interests or add_stop for the same request. To change it",
    "later, call make_for_you_route again with the whole ride restated ('forYou' below is what it holds now).",
    "A request about a named option ('based on the fastest route, go via X') is not that: use choose_route then add_stop.",
    "",
    "What is on screen now:",
    // Coordinates are for the tools, not for the model to reason about.
    JSON.stringify({ ...ctx, points: undefined }, null, 1),
  ].join("\n");
}

export async function runAssistant(
  model: LanguageModel,
  messages: ChatMessage[],
  ctx: AssistantContext
): Promise<{ reply: string; actions: AssistantAction[] }> {
  const actions: AssistantAction[] = [];
  // One lookup per place name: "boba and food in Chinatown" asks for Chinatown twice.
  const found = new Map<string, Promise<{ label: string; point: LatLng } | null>>();
  const findPlace = (q: string) => {
    const key = q.trim().toLowerCase();
    let hit = found.get(key);
    if (!hit) {
      hit = geocode(q, 1).then(([h]) => (h ? { label: h.label, point: { lat: h.lat, lng: h.lng } } : null));
      found.set(key, hit);
    }
    return hit;
  };
  // Tool calls of one reply run together, and set_trip waits on a lookup:
  // a ride asked for alongside a new trip must wait for that trip.
  let tripSet: Promise<unknown> = Promise.resolve();
  /** Both ends of the trip: as just set in this reply, else as on screen. */
  const tripLine = (): LatLng[] | null => {
    let from = ctx.points?.origin;
    let to = ctx.points?.destination;
    for (const a of actions) {
      if (a.type !== "set_trip") continue;
      from = a.from?.point ?? from;
      to = a.to?.point ?? to;
    }
    return from && to ? [from, to] : null;
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
        execute: ({ from, to }) =>
          (tripSet = (async () => {
            const a = from ? await findPlace(from) : undefined;
            const b = to ? await findPlace(to) : undefined;
            if ((from && !a) || (to && !b)) return { ok: false, error: `Could not find ${!a && from ? from : to} in San Francisco.` };
            actions.push({ type: "set_trip", from: a ?? undefined, to: b ?? undefined });
            return { ok: true, from: a?.label, to: b?.label };
          })()),
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
      make_for_you_route: tool({
        description:
          "Build the rider's own ride from everything they asked for and offer it as the 'For you' option, beside the others. Needs a start and destination. Replaces any earlier 'For you' ride.",
        inputSchema: z.object({
          basedOn: z
            .enum(["fastest", "balanced", "safest"])
            .describe(
              "Rules to ride by. fastest = quickest, avoids nothing. balanced = Safest: stays out of dangerous neighbourhoods and crash hotspots. safest = the same and keeps to protected bike lanes."
            ),
          avoidHills: z.boolean(),
          fewerLights: z.boolean(),
          stops: z
            .array(
              z.object({
                place: z.string().optional().describe("A place or neighbourhood in San Francisco, e.g. 'Chinatown', 'Ferry Building'"),
                kind: z
                  .enum(PLACE_KINDS)
                  .optional()
                  .describe("A kind of place to stop at. With `place`: one in or near it ('boba in Chinatown'). Alone: one on the way."),
              })
            )
            .max(MAX_FOR_YOU_STOPS)
            .describe("Places to pass, in any order - the app orders them along the trip."),
        }),
        execute: async ({ basedOn, avoidHills, fewerLights, stops }) => {
          await tripSet;
          const line = tripLine();
          if (!line) return { ok: false, error: "There is no trip yet - set a start and destination first." };
          const out: ForYouStop[] = [];
          const used = new Set<string>();
          for (const s of stops) {
            const near = s.place ? await findPlace(s.place) : undefined;
            if (s.place && !near) return { ok: false, error: `Could not find ${s.place} in San Francisco.` };
            if (!s.kind) {
              if (!near) return { ok: false, error: "Each stop needs a place, a kind, or both." };
              out.push({ name: near.label.split(",")[0], emoji: "📍", point: near.point });
              continue;
            }
            const kind = s.kind as PlaceInterest;
            const poi = nearestPlace(kind, near ? { near: near.point } : { line }, used);
            if (!poi) return { ok: false, error: `Could not find ${kind}${s.place ? ` near ${s.place}` : " on the way"}.` };
            used.add(poi.id);
            out.push({ name: poi.name, emoji: emojiFor(kind), point: { lat: poi.lat, lng: poi.lng } });
          }
          actions.push({ type: "for_you_route", basedOn, avoidHills, fewerLights, stops: out });
          return { ok: true, stops: out.map((s) => s.name), note: "The app plans it and reports its length, or that it could not." };
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
