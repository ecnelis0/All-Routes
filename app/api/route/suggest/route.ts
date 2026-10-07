import { NextResponse } from "next/server";
import { MAX_CUSTOM_WAYPOINTS, RoutingError } from "@/lib/routing/service";
import { suggestEdits } from "@/lib/routing/suggest";
import type { LatLng } from "@/lib/types";

/**
 * Suggested edits for the route being edited - see lib/routing/suggest.ts.
 * Computed only when the rider asks: it plans the trip ~11 more times.
 */
export const runtime = "nodejs";

const PROFILES = new Set(["fastest", "balanced", "safest"]);

function isLatLng(v: unknown): v is LatLng {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.lat === "number" && typeof p.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const { origin, destination, waypoints, profile, avoidElevation, fewerSignals, accepted, basePath } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (!isLatLng(origin) || !isLatLng(destination)) {
    return NextResponse.json({ error: "Both `origin` and `destination` must be {lat, lng} numbers." }, { status: 400 });
  }
  if (!Array.isArray(waypoints) || !waypoints.every(isLatLng) || waypoints.length > MAX_CUSTOM_WAYPOINTS) {
    return NextResponse.json({ error: `\`waypoints\` must be up to ${MAX_CUSTOM_WAYPOINTS} {lat, lng}.` }, { status: 400 });
  }
  if (typeof profile !== "string" || !PROFILES.has(profile)) {
    return NextResponse.json({ error: "`profile` must be fastest, balanced or safest." }, { status: 400 });
  }
  const acceptedList = Array.isArray(accepted) ? accepted.filter((a): a is string => typeof a === "string") : [];

  try {
    const suggestions = suggestEdits(
      origin,
      destination,
      waypoints,
      profile as "fastest" | "balanced" | "safest",
      { avoidElevation: avoidElevation === true, fewerSignals: fewerSignals === true },
      acceptedList,
      Array.isArray(basePath) && basePath.every(isLatLng) ? basePath : undefined
    );
    return NextResponse.json({ suggestions });
  } catch (err) {
    if (err instanceof RoutingError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
