"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSavedRoutes } from "@/lib/saved/useSavedRoutes";

/** One bar across every page: the two ways to plan a ride, and what you saved. */
export default function AppNav() {
  const pathname = usePathname();
  const saved = useSavedRoutes();
  // The headless tour-render page captures video frames - no chrome there.
  if (pathname.startsWith("/render")) return null;

  const tabs = [
    { href: "/", label: "Safety routing" },
    { href: "/explore", label: "Explore" },
    { href: "/saved", label: saved.length > 0 ? `Saved (${saved.length})` : "Saved" },
  ];
  return (
    <nav className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 text-sm" aria-label="Main">
      <span className="mr-3 font-bold text-black">🚲 No Roll Models</span>
      {tabs.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1 font-medium ${
              active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
