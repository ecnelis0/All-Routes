import { NextResponse } from "next/server";
import { MAX_CUSTOM_WAYPOINTS, planCustomRoute, RoutingError } from "@/lib/routing/service";
import type { LatLng } from "@/lib/types";

/**
 * Plans a rider-edited route: start -> each chosen stop, in order -> end,
 * using one profile's rules on every leg. See `planCustomRoute`.
 */
export const runtime = "nodejs";

const PROFILES = new Set(["fastest", "balanced", "safest"]);

function isLatLng(v: unknown): v is LatLng {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const { origin, destination, waypoints, profile, avoidElevation, fewerSignals } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (!isLatLng(origin) || !isLatLng(destination)) {
    return NextResponse.json({ error: "Both `origin` and `destination` must be {lat, lng} numbers." }, { status: 400 });
  }
  if (!Array.isArray(waypoints) || !waypoints.every(isLatLng)) {
    return NextResponse.json({ error: "`waypoints` must be an array of {lat, lng}." }, { status: 400 });
  }
  if (waypoints.length > MAX_CUSTOM_WAYPOINTS) {
    return NextResponse.json({ error: `At most ${MAX_CUSTOM_WAYPOINTS} stops.` }, { status: 400 });
  }
  if (typeof profile !== "string" || !PROFILES.has(profile)) {
    return NextResponse.json({ error: "`profile` must be fastest, balanced or safest." }, { status: 400 });
  }

  try {
    const route = planCustomRoute(origin, destination, waypoints, profile as "fastest" | "balanced" | "safest", {
      avoidElevation: avoidElevation === true,
      fewerSignals: fewerSignals === true,
    });
    return NextResponse.json({ route });
  } catch (err) {
    if (err instanceof RoutingError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
