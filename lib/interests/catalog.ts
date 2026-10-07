/**
 * The interest catalogue, safe to import in the browser (the planner itself
 * pulls in the street graph and must stay on the server).
 */

export type PlaceInterest = "beach" | "boba" | "coffee" | "food" | "park" | "viewpoint" | "art";
export type InterestId = PlaceInterest | "bikepaths";

export const INTERESTS: { id: InterestId; label: string; emoji: string }[] = [
  { id: "beach", label: "Beaches", emoji: "🏖️" },
  { id: "bikepaths", label: "Bike paths", emoji: "🚲" },
  { id: "boba", label: "Boba", emoji: "🧋" },
  { id: "coffee", label: "Coffee", emoji: "☕" },
  { id: "food", label: "Food", emoji: "🍜" },
  { id: "park", label: "Parks", emoji: "🌳" },
  { id: "viewpoint", label: "Views", emoji: "🌉" },
  { id: "art", label: "Street art", emoji: "🎨" },
];

export interface Poi {
  id: string;
  category: PlaceInterest;
  name: string;
  lat: number;
  lng: number;
}

/** The InterestRoute shape as it arrives in the browser. */
export interface InterestRide {
  style: "quick" | "relaxed";
  styleLabel: string;
  stops: Poi[];
  along: Poi[];
  extraPercent: number;
}

export function emojiFor(category: string): string {
  return INTERESTS.find((i) => i.id === category)?.emoji ?? "📍";
}
