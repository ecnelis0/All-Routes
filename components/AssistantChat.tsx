"use client";

import { useRef, useState } from "react";
import { describeActions, type AssistantAction, type AssistantContext, type ChatMessage } from "@/lib/assistant/actions";

/**
 * The route assistant in the sidebar. The rider types what they want; the
 * reply changes the plan through the same controls they could use by hand
 * (see lib/assistant/actions.ts), and says what it changed.
 */

interface Turn extends ChatMessage {
  /** For assistant turns: what the reply changed, one line each. */
  changes?: string[];
}

const EXAMPLES = [
  "Avoid hills and take me past a beach",
  "Go via Ocean Beach",
  "Why is Safest slower than Fastest?",
];

export default function AssistantChat({
  context,
  onActions,
}: {
  context: AssistantContext;
  onActions: (actions: AssistantAction[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const history: Turn[] = [...turns, { role: "user", content }];
    setTurns(history);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })), context }),
      });
      const json = (await res.json()) as { reply?: string; actions?: AssistantAction[]; error?: string };
      if (!res.ok || !json.reply) {
        setError(json.error ?? `The assistant could not answer (${res.status}).`);
        return;
      }
      const actions = json.actions ?? [];
      setTurns([...history, { role: "assistant", content: json.reply, changes: describeActions(actions) }]);
      if (actions.length) onActions(actions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The assistant could not answer.");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-violet-300 bg-violet-50/60 p-2.5" data-testid="assistant">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center justify-between text-left text-xs font-semibold uppercase tracking-wide text-violet-900"
      >
        <span>✨ Ask the route assistant</span>
        <span className="text-[10px] font-normal normal-case">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <>
          {turns.length > 0 && (
            <div ref={listRef} className="flex max-h-60 flex-col gap-1.5 overflow-y-auto" data-testid="assistant-turns">
              {turns.map((t, i) => (
                <div
                  key={i}
                  className={`rounded-lg px-2.5 py-1.5 text-xs leading-snug ${
                    t.role === "user" ? "self-end bg-violet-700 text-white" : "self-start bg-white text-black shadow-sm"
                  }`}
                >
                  {t.content}
                  {t.changes && t.changes.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 border-t border-violet-100 pt-1 text-[10px] text-violet-800">
                      {t.changes.map((c) => (
                        <li key={c}>✓ {c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {busy && <div className="self-start rounded-lg bg-white px-2.5 py-1.5 text-xs text-black/50 shadow-sm">Thinking…</div>}
            </div>
          )}
          {turns.length === 0 && (
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => void send(e)}
                  className="rounded-full border border-violet-300 bg-white px-2 py-0.5 text-[11px] text-violet-900 hover:bg-violet-100"
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. flat ride past the ocean, boba on the way"
              aria-label="Message the route assistant"
              className="min-w-0 flex-1 rounded-md border border-violet-300 bg-white px-2 py-1.5 text-xs text-black"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-md bg-violet-700 px-3 text-xs font-semibold text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
          {error && <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">{error}</p>}
        </>
      )}
    </section>
  );
}
