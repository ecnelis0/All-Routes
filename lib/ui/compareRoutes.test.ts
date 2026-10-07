import { describe, expect, it } from "vitest";
import { bestForBadges, compareRoutes, type ComparableRoute } from "./compareRoutes";

const base: ComparableRoute = {
  distanceMeters: 4000,
  meanDanger: 60,
  maxDanger: 90,
  protectedLaneFraction: 0.2,
  trafficSignals: 20,
  elevationGainMeters: 100,
  elevationLossMeters: 80,
  maxGradePercent: 15,
  maxDownGradePercent: 12,
  metersInFlaggedAreas: 1000,
};
const short = { ...base };
const safe = { ...base, distanceMeters: 5000, meanDanger: 40, maxDanger: 70, metersInFlaggedAreas: 0 };
const flat = { ...base, distanceMeters: 5500, protectedLaneFraction: 0.6, elevationGainMeters: 20, elevationLossMeters: 10, trafficSignals: 9 };

const row = (rows: ReturnType<typeof compareRoutes>, label: string) => rows.find((r) => r.label === label)!;

describe("compareRoutes", () => {
  const rows = compareRoutes([short, safe, flat]);

  it("marks the best route per row, lower or higher as the stat demands", () => {
    expect(row(rows, "Distance").best).toEqual([0]);
    expect(row(rows, "Danger (avg)").best).toEqual([1]);
    expect(row(rows, "On protected lanes").best).toEqual([2]); // higher is better
    expect(row(rows, "Total elevation change").best).toEqual([2]);
    expect(row(rows, "Total elevation change").values).toEqual(["591 ft", "591 ft", "98 ft"]);
  });

  it("shares a win on ties and marks nothing when every route is equal", () => {
    expect(row(rows, "Danger (avg)").values).toEqual(["60.0", "40.0", "60.0"]);
    expect(row(rows, "Steepest climb").best).toEqual([]); // all 15%
  });

  it("judges on what is shown, so invisible rounding never decides a winner", () => {
    const a = { ...base, distanceMeters: 4000 };
    const b = { ...base, distanceMeters: 4010 }; // both display "2.5 mi"
    expect(row(compareRoutes([a, b]), "Distance").best).toEqual([]);
  });

  it("gives 'best for' badges, never one every route shares", () => {
    const badges = bestForBadges(rows, 3);
    expect(badges[0]).toEqual(["Shortest"]);
    expect(badges[1]).toEqual(["Safest"]);
    expect(badges[2]).toEqual(["Most protected", "Flattest", "Fewest lights"]);
  });
});
