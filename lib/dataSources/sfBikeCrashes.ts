import type { CrashRecord, Severity } from "../types";
import data from "../data/sfBikeCrashes.json";

/**
 * Real bicycle-involved injury crashes in San Francisco, 2019 onward, from
 * DataSF "Traffic Crashes Resulting in Injury" (SFPD reports). Imported by
 * `scripts/importSfBikeCrashes.mjs`; see that file for what is kept and how
 * severity is mapped.
 *
 * These replace the randomly generated mock crashes in `lib/mockData.ts`,
 * which until now fed the router's danger score - so a street's score
 * reflected where the prototype happened to scatter fake incidents rather
 * than where cyclists are actually hurt.
 *
 * Caveat worth knowing when reading scores: these are raw counts, not
 * rates. A street many people ride (Market, Valencia) collects more
 * crashes partly because it carries more cyclists. No public per-street
 * bike-volume data exists to normalise by, so the router weighs crashes
 * alongside lane protection, traffic speed and road class rather than on
 * their own.
 */

interface CrashFile {
  source: string;
  fromYear: number;
  importedAt: string;
  count: number;
  crashes: { id: string; lat: number; lng: number; severity: number; date: string; kind: string; where: string }[];
}

const file = data as CrashFile;

export const REAL_SF_BIKE_CRASHES: CrashRecord[] = file.crashes.map((c) => ({
  id: c.id,
  position: { lat: c.lat, lng: c.lng },
  type: "collision",
  severity: c.severity as Severity,
  date: c.date,
  description: `${c.kind}${c.where ? ` at ${c.where}` : ""}`,
  source: "city-open-data",
}));

export const SF_BIKE_CRASHES_SOURCE = file.source;
export const SF_BIKE_CRASHES_FROM_YEAR = file.fromYear;
