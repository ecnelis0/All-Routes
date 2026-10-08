import { describe, expect, it } from "vitest";
import { classifyPlace, MAX_OFF_ROUTE_METERS, placesAlongRoute, samplePoints, type Fetcher } from "./wikipedia";

describe("classifyPlace", () => {
  it("keeps places worth riding to, by Wikipedia's own description", () => {
    expect(classifyPlace("China Beach, San Francisco", "Beach in San Francisco, California")).toBe("🏖️");
    expect(classifyPlace("Lands End (San Francisco)", "Park in San Francisco")).toBe("🌳");
    expect(classifyPlace("Palace of Fine Arts", "Monumental structure in San Francisco")).toBe("🏛️");
    expect(classifyPlace("Lobos Creek", "Creek in San Francisco")).toBe("💧");
  });

  it("drops what the location search also returns: schools, houses, neighbourhoods", () => {
    expect(classifyPlace("Katherine Delmar Burke School", "Private school in San Francisco")).toBeNull();
    expect(classifyPlace("Sea Cliff, San Francisco", "Neighborhood in San Francisco")).toBeNull();
    expect(classifyPlace("Black House (Church of Satan)", "Former house in San Francisco")).toBeNull();
    // Events have articles with coordinates too - "Six Gallery reading" is a 1955 poetry event.
    expect(classifyPlace("Six Gallery reading", '1955 poetry event at which "Howl" was first read')).toBeNull();
    // A "park" word in a school's name does not make it a park.
    expect(classifyPlace("Park Day School", "Private school in Oakland")).toBeNull();
  });
});

describe("placesAlongRoute", () => {
  const M = 1 / 111_320;
  const path = [0, 1000, 2000, 3000].map((n) => ({ lat: 37.76 + n * M, lng: -122.5 }));
  const mPerLng = 111_320 * Math.cos((37.76 * Math.PI) / 180);
  const page = (pageid: number, title: string, description: string, north: number, east: number, image = true) => ({
    pageid,
    title,
    description,
    extract: `${title} is lovely. Go at sunset.`,
    thumbnail: image ? { source: `https://img/${pageid}.jpg` } : undefined,
    coordinates: [{ lat: 37.76 + north * M, lon: -122.5 + east / mPerLng }],
  });
  const fetcher: Fetcher = async () => ({
    query: {
      pages: {
        "1": page(1, "Late Beach", "Beach", 2500, 100),
        "2": page(2, "Early Park", "Park", 500, 200),
        "3": page(3, "Far Park", "Park", 1500, MAX_OFF_ROUTE_METERS + 300),
        "4": page(4, "A School", "Private school", 1000, 50),
      },
    },
  });

  it("returns only nearby places worth a stop, in riding order, with photo and why-go", async () => {
    const places = await placesAlongRoute(path, fetcher);
    expect(places.map((p) => p.title)).toEqual(["Early Park", "Late Beach"]);
    expect(places[0].image).toBe("https://img/2.jpg");
    expect(places[0].extract).toBe("Early Park is lovely. Go at sunset.");
    expect(places[0].url).toBe("https://en.wikipedia.org/wiki/Early_Park");
  });

  it("samples the route often enough that nothing between search points is missed", () => {
    const pts = samplePoints(path, 1200);
    // 3 km route, searches every 1.2 km with a 1 km radius: start, ~1.2/2 km, end.
    expect(pts.length).toBeGreaterThanOrEqual(3);
    expect(pts[0]).toEqual(path[0]);
    expect(pts.at(-1)).toEqual(path.at(-1));
  });
});
