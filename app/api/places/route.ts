import { NextResponse } from "next/server";
import { placesAlongRoute } from "@/lib/places/wikipedia";
import type { LatLng } from "@/lib/types";

/** Places worth a stop along a route, from Wikipedia - see lib/places/wikipedia.ts. */
export const runtime = "nodejs";

const USER_AGENT = "AllRoutes/1.0 (bike route planner; places along the way)";

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const path = (body as { path?: unknown })?.path;
  const valid =
    Array.isArray(path) &&
    path.length >= 2 &&
    path.length <= 20_000 &&
    path.every((p: LatLng) => typeof p?.lat === "number" && typeof p?.lng === "number");
  if (!valid) return NextResponse.json({ error: "`path` must be a list of {lat, lng}." }, { status: 400 });
  try {
    const places = await placesAlongRoute(path as LatLng[], fetchJson);
    return NextResponse.json({ places, attribution: "Text and photos from Wikipedia / Wikimedia Commons" });
  } catch {
    return NextResponse.json({ error: "Could not reach Wikipedia right now." }, { status: 502 });
  }
}
