import { redirect } from "next/navigation";

/**
 * Explore used to be a separate page. Interests now live in the main
 * sidebar ("What do you like?") and add a "For you" route alongside the
 * other options, so they work together with every other setting.
 */
export default function ExplorePage() {
  redirect("/");
}
