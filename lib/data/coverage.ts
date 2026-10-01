/**
 * The area the routing graph actually covers.
 *
 * MUST match `BOUNDS` in `scripts/fetchSfBikeGraph.mjs` - there is a test
 * (`coverage.test.ts`) asserting it equals the bounds recorded in the
 * generated graph, because the two drifting apart is silent and ugly.
 *
 * Deliberately NOT `DEMO_CITY.bounds`, which is the narrower box the
 * original map display and danger grid used. Confusing the two caused a
 * real bug: the address search bounded its geocoder queries to
 * DEMO_CITY's west edge of -122.462, which excludes Ocean Beach
 * (-122.511) and most of Golden Gate Park. Searching "Ocean Beach"
 * returned a company called "Sofar Ocean" in the Financial District
 * instead - a confident, completely wrong answer, and the user had no way
 * to tell.
 */
export const COVERAGE_BOUNDS = {
  north: 37.812,
  south: 37.705,
  east: -122.355,
  west: -122.515,
} as const;

export function isWithinCoverage(lat: number, lng: number): boolean {
  return (
    lat >= COVERAGE_BOUNDS.south &&
    lat <= COVERAGE_BOUNDS.north &&
    lng >= COVERAGE_BOUNDS.west &&
    lng <= COVERAGE_BOUNDS.east
  );
}
