import { NextResponse } from "next/server";
import { geocode, type GeocodeHit } from "@/lib/geocode";

/** Address search for the address boxes - see lib/geocode.ts. */
export const runtime = "nodejs";

export type { GeocodeHit };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ results: [] });
  }
  try {
    return NextResponse.json({ results: await geocode(q) });
  } catch (err) {
    return NextResponse.json(
      {
        results: [],
        error: `Address lookup failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 502 }
    );
  }
}
