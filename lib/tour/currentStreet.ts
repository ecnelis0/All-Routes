export interface StreetSpan {
  name: string;
  startMeters: number;
  endMeters: number;
}

/**
 * The street a rider is on after travelling `metersDone` along a route.
 *
 * Extracted from the tour component so it can be tested directly: the
 * failure mode here is a label that is confidently wrong rather than
 * absent, which no amount of looking at a screenshot reliably catches.
 *
 * Roughly a fifth of a typical route runs on unnamed geometry - park
 * paths, alley connectors, freeway slip lanes - so an exact span hit
 * frequently misses. The correct answer in that gap is the most recent
 * named street, not the first one on the route: you are between named
 * streets, and the one you just left is what orients you.
 */
export function currentStreetAt(spans: StreetSpan[], metersDone: number): string | null {
  if (spans.length === 0) return null;

  const exact = spans.find((s) => metersDone >= s.startMeters && metersDone <= s.endMeters);
  if (exact) return exact.name;

  // Before the first named street - nothing sensible to report yet.
  let best: StreetSpan | null = null;
  for (const s of spans) {
    if (s.startMeters <= metersDone && (!best || s.startMeters > best.startMeters)) best = s;
  }
  return best?.name ?? null;
}
