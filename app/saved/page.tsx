"use client";

import { useJsApiLoader } from "@react-google-maps/api";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import MapView, { type MapPlace, type MapRouteKind } from "@/components/MapView";
import ProfileChart from "@/components/ProfileChart";
import { RouteChoiceList } from "@/components/RouteChoices";
import { emojiFor } from "@/lib/interests/catalog";
import { buildManeuvers, formatDistance } from "@/lib/nav/instructions";
import { deleteSaved, renameSaved, shortPlace, type SavedRoute } from "@/lib/saved/store";
import { useSavedRoutes } from "@/lib/saved/useSavedRoutes";
import { buildElevationProfile } from "@/lib/tour/elevationProfile";
import { compareRoutes } from "@/lib/ui/compareRoutes";
import { describeRoute } from "@/lib/ui/routeDescription";

const Route3DTour = dynamic(() => import("@/components/Route3DTour"), { ssr: false });
const NavigationView = dynamic(() => import("@/components/NavigationView"), { ssr: false });

/**
 * SAVED: every route the rider saved, with everything about it - stats,
 * what it did, elevation, areas, stops, turn-by-turn - and the 3D tour and
 * navigation one click away.
 */

// Must match the loader options on the other pages exactly.
const LIBRARIES: [] = [];
const MPS = 3.6;
const minutes = (m: number) => Math.max(1, Math.round(m / MPS / 60));
const miles = (m: number) => (m / 1609.34).toFixed(1);
const ft = (m: number) => Math.round(Math.round(m) * 3.281);

function kindOf(s: SavedRoute): MapRouteKind {
  return s.source === "explore" || s.route.customWaypoints ? "custom" : s.route.profile;
}

function describe(s: SavedRoute) {
  // Explore stops were picked for the rider, not placed by hand.
  const r = s.source === "explore" ? { ...s.route, customWaypoints: undefined } : s.route;
  return describeRoute(r, String(minutes(s.route.distanceMeters)));
}

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function SavedPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <Saved />
    </Suspense>
  );
}

function Saved() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const { isLoaded } = useJsApiLoader({ id: "google-map-script", googleMapsApiKey: apiKey ?? "", libraries: LIBRARIES });
  const saved = useSavedRoutes();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get("id");
  const open = saved.find((s) => s.id === openId) ?? null;

  const [tourOpen, setTourOpen] = useState(false);
  const [navSource, setNavSource] = useState<"gps" | "simulate" | null>(null);

  function select(id: string | null) {
    setTourOpen(false);
    setNavSource(null);
    router.push(id ? `/saved?id=${id}` : "/saved");
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[26rem] shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-200 bg-white p-4 text-black">
        {open ? (
          <Detail
            key={open.id}
            s={open}
            tourOpen={tourOpen}
            onBack={() => select(null)}
            onTour={() => setTourOpen((o) => !o)}
            onNavigate={(src) => {
              setTourOpen(false);
              setNavSource(src);
            }}
            onDeleted={() => select(null)}
          />
        ) : (
          <List saved={saved} onOpen={(id) => select(id)} />
        )}
      </aside>

      <main className="relative min-h-0 flex-1">
        <MapView
          center={{ lat: 37.7749, lng: -122.4194 }}
          isLoaded={isLoaded}
          origin={open?.from.point ?? null}
          destination={open?.to.point ?? null}
          routes={open ? [{ kind: kindOf(open), path: open.route.path, description: describe(open) }] : []}
          selectedKind={open ? kindOf(open) : null}
          focused
          places={
            open?.places?.map(
              (p, i): MapPlace => ({ id: p.id, name: p.name, emoji: emojiFor(p.category), position: p, stopNumber: i + 1 })
            ) ?? []
          }
        />
        {!open && saved.length > 0 && (
          <p className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-white/90 px-4 py-1.5 text-sm text-slate-700 shadow">
            Pick a saved route to see it here
          </p>
        )}
        {open && tourOpen && (
          <Route3DTour
            path={open.route.path}
            profile={open.route.profile}
            streetSpans={open.route.streetSpans}
            classSpans={open.route.classSpans}
            pathElevations={open.route.pathElevations}
            protectedSpans={open.route.protectedSpans}
            avoidedNearby={open.route.avoidedNearby}
            details={describe(open)}
            onClose={() => setTourOpen(false)}
          />
        )}
        {open && navSource && (
          <NavigationView
            route={open.route}
            destination={open.to.point}
            source={navSource}
            avoidElevation={open.settings.avoidElevation}
            fewerSignals={open.settings.fewerSignals}
            details={describe(open)}
            waypoints={open.route.customWaypoints}
            onExit={() => setNavSource(null)}
          />
        )}
      </main>
    </div>
  );
}

function List({ saved, onOpen }: { saved: SavedRoute[]; onOpen: (id: string) => void }) {
  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Saved routes</h1>
        <p className="text-xs text-black/60">
          Saved in this browser - they stay after you close it, but only on this device.
        </p>
      </div>
      {saved.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-black/70">
          Nothing saved yet. Plan a route on{" "}
          <Link href="/" className="font-semibold text-blue-700 underline">
            Safety routing
          </Link>{" "}
          or{" "}
          <Link href="/explore" className="font-semibold text-blue-700 underline">
            Explore
          </Link>
          , confirm it, and press <span className="font-semibold">Save route</span>.
        </div>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="saved-list">
          {saved.map((s) => {
            const prof = buildElevationProfile(s.route.path, s.route.pathElevations);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="flex w-full flex-col gap-1 rounded-lg border border-slate-200 p-3 text-left hover:border-slate-400 hover:bg-slate-50"
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{s.name}</span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        s.source === "explore" ? "bg-teal-100 text-teal-800" : "bg-blue-100 text-blue-800"
                      }`}
                    >
                      {s.source === "explore" ? "Explore" : "Safety"}
                    </span>
                  </span>
                  <span className="text-xs text-black/60">
                    {shortPlace(s.from.label)} → {shortPlace(s.to.label)} · saved {when(s.savedAt)}
                  </span>
                  <span className="text-xs">
                    {miles(s.route.distanceMeters)} mi · ~{minutes(s.route.distanceMeters)} min · danger{" "}
                    {s.route.meanDanger} · ▲ {ft(s.route.elevationGainMeters)} ft · {s.route.trafficSignals} lights
                  </span>
                  {prof && <ProfileChart profile={prof} width={340} height={32} fill="rgba(59,130,246,0.45)" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Detail({
  s,
  tourOpen,
  onBack,
  onTour,
  onNavigate,
  onDeleted,
}: {
  s: SavedRoute;
  tourOpen: boolean;
  onBack: () => void;
  onTour: () => void;
  onNavigate: (src: "gps" | "simulate") => void;
  onDeleted: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const r = s.route;
  const description = describe(s);
  const rows = useMemo(() => compareRoutes([r]), [r]);
  const profile = useMemo(() => buildElevationProfile(r.path, r.pathElevations), [r]);
  const turns = useMemo(() => buildManeuvers(r.path, r.streetSpans), [r]);

  return (
    <div className="flex flex-col gap-3" data-testid="saved-detail">
      <button type="button" onClick={onBack} className="self-start text-xs font-medium text-blue-700 hover:underline">
        ← All saved routes
      </button>

      {renaming ? (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            renameSaved(s.id, name);
            setRenaming(false);
          }}
        >
          <input
            aria-label="Route name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={80}
            className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <button type="submit" className="rounded bg-slate-900 px-2 text-xs font-semibold text-white">
            Save
          </button>
        </form>
      ) : (
        <h1 className="text-lg font-semibold leading-tight">{s.name}</h1>
      )}
      <p className="-mt-2 text-xs text-black/60">
        {s.from.label} → {s.to.label}
        <br />
        Saved {when(s.savedAt)} · {s.source === "explore" ? "Explore ride" : r.label} · Avoid hills{" "}
        {s.settings.avoidElevation ? "on" : "off"} · Fewer lights {s.settings.fewerSignals ? "on" : "off"}
      </p>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => onNavigate("gps")}
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white"
        >
          Start navigation
        </button>
        <button
          type="button"
          onClick={() => onNavigate("simulate")}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Simulate ride
        </button>
        <button
          type="button"
          onClick={onTour}
          aria-pressed={tourOpen}
          className={`col-span-2 rounded-md border px-3 py-2 text-sm font-medium ${
            tourOpen ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:bg-slate-50"
          }`}
        >
          {tourOpen ? "Close 3D tour" : "View 3D tour"}
        </button>
      </div>

      <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
        <RouteChoiceList description={description} />
      </section>

      {s.places && s.places.length > 0 && (
        <section className="text-xs">
          <h2 className="mb-1 font-semibold">Stops</h2>
          <ol className="flex flex-col gap-1">
            {s.places.map((p, i) => (
              <li key={p.id}>
                {i + 1}. {emojiFor(p.category)} {p.name}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="text-xs" data-testid="saved-stats">
        <h2 className="mb-1 font-semibold">The numbers</h2>
        <table className="w-full">
          <tbody>
            <tr className="border-t border-slate-100">
              <td className="py-1 text-black/70">Est. time</td>
              <td className="py-1 text-right font-medium">~{minutes(r.distanceMeters)} min</td>
            </tr>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-slate-100">
                <td className="py-1 text-black/70">{row.label}</td>
                <td className="py-1 text-right font-medium">{row.values[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {profile && (
        <section className="text-xs">
          <h2 className="mb-1 font-semibold">Elevation</h2>
          <ProfileChart profile={profile} width={350} height={70} fill="rgba(59,130,246,0.5)" />
          <p className="mt-0.5 text-black/60">
            ▲ {ft(r.elevationGainMeters)} ft climbed · ▼ {ft(r.elevationLossMeters)} ft dropped · steepest{" "}
            {r.maxGradePercent}% up / {r.maxDownGradePercent}% down
          </p>
        </section>
      )}

      <section className="text-xs">
        <h2 className="mb-1 font-semibold">Flagged areas</h2>
        {r.neighborhoodsEntered.length === 0 ? (
          <p className="text-black/60">None - this route stays clear of all of them.</p>
        ) : (
          <ul className="list-disc pl-4">
            {r.neighborhoodsEntered.map((n) => (
              <li key={n.name}>
                {n.name} ({n.tier}, {miles(n.meters)} mi{n.atEndpoint ? ", trip starts or ends here" : ""})
              </li>
            ))}
          </ul>
        )}
      </section>

      {r.steepClimbs.length > 0 && (
        <section className="text-xs">
          <h2 className="mb-1 font-semibold">Hard climbs</h2>
          <ul className="list-disc pl-4">
            {r.steepClimbs.slice(0, 5).map((c) => (
              <li key={`${c.name}-${c.severity}`}>
                {c.name} ({c.severity.toLowerCase()}, {ft(c.meters)} ft)
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer font-semibold">Turn-by-turn ({turns.length} steps)</summary>
        <ol className="mt-1 flex flex-col gap-1">
          {turns.map((m, i) => {
            const leg = (turns[i + 1]?.atMeters ?? m.atMeters) - m.atMeters;
            return (
              <li key={`${m.atMeters}-${i}`} className="flex justify-between gap-2 border-b border-slate-100 pb-1">
                <span>{m.text}</span>
                {leg > 0 && <span className="shrink-0 text-black/50">{formatDistance(leg)}</span>}
              </li>
            );
          })}
        </ol>
      </details>

      <details className="text-xs">
        <summary className="cursor-pointer font-semibold">Streets ({r.streets.length})</summary>
        <p className="mt-1 leading-snug text-black/70">{r.streets.join(" → ")}</p>
      </details>

      <div className="flex gap-1.5 border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={() => {
            setName(s.name);
            setRenaming(true);
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
        >
          Rename
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              onClick={() => {
                deleteSaved(s.id);
                onDeleted();
              }}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Yes, delete it
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium"
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
