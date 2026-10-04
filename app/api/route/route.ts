import { NextResponse } from "next/server";
import { planRoutes, RoutingError, getRoutingEngine } from "@/lib/routing/service";
import type { LatLng } from "@/lib/types";

/**
 * Computes the three safety route profiles between two points.
 *
 * Server-side by necessity: the routing graph is ~5.7MB encoded and
 * ~210k directed edges decoded, which is far too much to ship to a browser
 * on every page load, and the A* search over it wants to run next to the
 * data rather than across a network. The client sends two coordinates and
 * gets back three finished routes.
 *
 * This replaces the previous approach of calling Google's Directions API
 * from the browser and nudging the result with waypoints - see
 * `lib/routing/cost.ts` for why routing on our own graph is the only way
 * "avoid these areas" can be a guarantee rather than a suggestion.
 */
export const runtime = "nodejs";

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

  const { origin, destination, avoidElevation } = (body ?? {}) as Record<string, unknown>;
  if (!isLatLng(origin) || !isLatLng(destination)) {
    return NextResponse.json(
      { error: "Both `origin` and `destination` must be {lat, lng} numbers." },
      { status: 400 }
    );
  }

  try {
    const started = Date.now();
    const routes = planRoutes(origin, destination, { avoidElevation: avoidElevation === true });
    const engine = getRoutingEngine();
    return NextResponse.json({
      routes,
      meta: {
        computedInMs: Date.now() - started,
        // Surfaced so it is obvious in the UI whether a trained model is
        // actually in use, rather than the baseline quietly standing in.
        modelSource: engine.modelSource,
        modelVersion: engine.model.version,
      },
    });
  } catch (err) {
    if (err instanceof RoutingError) {
      // Expected, user-correctable conditions (point outside coverage,
      // nothing routable nearby) - not server faults.
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
