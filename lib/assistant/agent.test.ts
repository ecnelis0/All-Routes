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

  it("is told the safety rules and what is on screen, so it explains instead of promising", () => {
    const p = systemPrompt(ctx);
    expect(p).toContain("never enter Severe areas");
    expect(p).toContain("Marina Green");
    expect(p).toContain("Fastest: 4.6 mi");
  });
});
