import { NextResponse } from "next/server";
import { RoutingError } from "@/lib/routing/service";
import { INTERESTS, planInterestRoutes, type InterestId } from "@/lib/interests/planner";
import type { LatLng } from "@/lib/types";

/** Rides shaped around the rider's interests - see lib/interests/planner.ts. */
export const runtime = "nodejs";

const VALID = new Set<string>(INTERESTS.map((i) => i.id));

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
  const { origin, destination, interests, avoidElevation, fewerSignals } = (body ?? {}) as Record<string, unknown>;
  if (!isLatLng(origin) || !isLatLng(destination)) {
    return NextResponse.json({ error: "Both `origin` and `destination` must be {lat, lng} numbers." }, { status: 400 });
  }
  if (!Array.isArray(interests) || interests.length === 0 || !interests.every((i) => typeof i === "string" && VALID.has(i))) {
    return NextResponse.json({ error: `Pick at least one interest: ${[...VALID].join(", ")}.` }, { status: 400 });
  }
  try {
    const rides = planInterestRoutes(origin, destination, interests as InterestId[], {
      avoidElevation: avoidElevation === true,
      fewerSignals: fewerSignals === true,
    });
    return NextResponse.json({ rides });
  } catch (err) {
    if (err instanceof RoutingError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}
