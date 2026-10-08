import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { runAssistant } from "@/lib/assistant/agent";
import type { AssistantContext, ChatMessage } from "@/lib/assistant/actions";

/**
 * The route assistant - see lib/assistant/agent.ts. Server-only: the OpenAI
 * key (OPENAI_API_KEY in .env.local) never reaches the browser.
 */
export const runtime = "nodejs";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "The assistant needs an OpenAI key: add OPENAI_API_KEY to .env.local and restart the dev server." },
      { status: 503 }
    );
  }
  let body: { messages?: ChatMessage[]; context?: AssistantContext };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12) // recent turns are enough, and keep the request small
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Send a message." }, { status: 400 });
  }
  if (!body.context) return NextResponse.json({ error: "Missing context." }, { status: 400 });
  try {
    const out = await runAssistant(openai(MODEL), messages, body.context);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: `The assistant could not answer: ${e instanceof Error ? e.message : "unknown error"}` },
      { status: 502 }
    );
  }
}
