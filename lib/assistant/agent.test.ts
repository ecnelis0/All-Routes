import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { runAssistant, systemPrompt } from "./agent";
import { describeActions, type AssistantContext } from "./actions";

// No network in tests: "Ocean Beach" resolves, "Atlantis" does not.
vi.mock("../geocode", () => ({
  geocode: async (q: string) =>
    /ocean beach/i.test(q) ? [{ label: "Ocean Beach, Sunset District, San Francisco", lat: 37.7561, lng: -122.5102 }] : [],
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** A model that makes these tool calls on its first turn, then says `reply`. */
function scripted(calls: { toolName: string; input: object }[], reply: string) {
  let turn = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      turn++;
      if (turn === 1 && calls.length) {
        return {
          content: calls.map((c, i) => ({
            type: "tool-call" as const,
            toolCallId: `call-${i}`,
            toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: "text" as const, text: reply }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
    },
  });
}

const ctx: AssistantContext = {
  from: "Marina Green",
  to: "Inner Sunset",
  settings: { avoidHills: false, fewerLights: false },
  interests: [],
  routes: ["Fastest: 4.6 mi, ~45 min", "Safest: 5.2 mi, ~51 min"],
  selected: { label: "Fastest", facts: ["✕ Did not avoid hills"] },
  myRoute: null,
};
const confirmed: AssistantContext = {
  ...ctx,
  myRoute: { label: "My route (Safest)", stops: 2, avoidsHills: false, fewerLights: false, summary: "5.2 mi, ~51 min" },
};

describe("route assistant", () => {
  it("turns a request into the app's own actions, with places looked up", async () => {
    const model = scripted(
      [
        { toolName: "set_settings", input: { avoidHills: true } },
        { toolName: "set_interests", input: { interests: ["beach", "boba"] } },
        { toolName: "add_stop", input: { place: "Ocean Beach" } },
      ],
      "Turned on Avoid hills, added beaches and boba, and routed you via Ocean Beach."
    );
    const out = await runAssistant(model, [{ role: "user", content: "flat ride past the beach with boba, via Ocean Beach" }], ctx);
    expect(out.reply).toContain("Avoid hills");
    expect(out.actions).toEqual([
      { type: "set_settings", avoidHills: true },
      { type: "set_interests", interests: ["beach", "boba"] },
      { type: "add_stop", label: "Ocean Beach, Sunset District, San Francisco", point: { lat: 37.7561, lng: -122.5102 } },
    ]);
    expect(describeActions(out.actions)).toEqual([
      "Avoid hills on",
      "Interests: beach, boba",
      "Added stop: Ocean Beach",
    ]);
  });

  it("never invents a stop it could not find", async () => {
    const model = scripted([{ toolName: "add_stop", input: { place: "Atlantis" } }], "I couldn't find Atlantis.");
    const out = await runAssistant(model, [{ role: "user", content: "go via Atlantis" }], ctx);
    expect(out.actions).toEqual([]);
  });

  it("rejects interests that do not exist rather than passing them on", async () => {
    const model = scripted([{ toolName: "set_interests", input: { interests: ["casinos"] } }], "Sorry.");
    const out = await runAssistant(model, [{ role: "user", content: "casinos please" }], ctx);
    expect(out.actions).toEqual([]);
  });

  it("edits the confirmed route: removes a stop, asks for a faster version", async () => {
    const model = scripted(
      [
        { toolName: "remove_stop", input: { stop: 2 } },
        { toolName: "improve_route", input: { goal: "faster" } },
      ],
      "Dropped stop 2 and looked for a faster way."
    );
    const out = await runAssistant(model, [{ role: "user", content: "drop the second stop and make it quicker" }], confirmed);
    expect(out.actions).toEqual([
      { type: "remove_stop", stop: 2 },
      { type: "improve_route", goal: "faster" },
    ]);
  });

  it("cannot edit 'my route' before one is confirmed, or remove a stop that is not there", async () => {
    const before = await runAssistant(
      scripted([{ toolName: "improve_route", input: { goal: "flatter" } }], "Confirm a route first."),
      [{ role: "user", content: "make it flatter" }],
      ctx
    );
    expect(before.actions).toEqual([]);
    const missing = await runAssistant(
      scripted([{ toolName: "remove_stop", input: { stop: 5 } }], "There is no stop 5."),
      [{ role: "user", content: "remove stop 5" }],
      confirmed
    );
    expect(missing.actions).toEqual([]);
  });

  it("is told that once confirmed, requests edit the rider's own route", () => {
    expect(systemPrompt(confirmed)).toContain("it is THEIR route");
    expect(systemPrompt(confirmed)).toContain("My route (Safest)");
  });

  it("is told the safety rules and what is on screen, so it explains instead of promising", () => {
    const p = systemPrompt(ctx);
    expect(p).toContain("never enter Severe areas");
    expect(p).toContain("Marina Green");
    expect(p).toContain("Fastest: 4.6 mi");
  });
});
