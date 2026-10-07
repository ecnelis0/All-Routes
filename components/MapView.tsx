"use client";

// The "F" (function component) versions, not the class ones: under React
// 18+ the class Polyline/Marker do not reliably remove themselves from the
// map on unmount, so a route taken off screen stayed painted - selecting
// one route left the other two drawn underneath it.
import { CircleF, GoogleMap, InfoWindowF, MarkerF, OverlayViewF, PolylineF } from "@react-google-maps/api";
import {
  neighborhoodRiskColor,
  type DangerousNeighborhood,
} from "@/lib/data/sfDangerousNeighborhoods";
import { useMemo } from "react";
import type { RouteDescription } from "@/lib/ui/routeDescription";
import { distanceToPath } from "@/lib/ui/geometry";
import type {
  DangerFactorScores,
  DangerZone,
  LatLng,
  MapLayerId,
  RoadKind,
  RoadSafetySegment,
  RouteOptionKind,
} from "@/lib/types";

export interface SelectedRouteDisplay {
  /** Matches `RouteSummary["profile"]` from lib/routing/service.ts. */
  kind: "fastest" | "balanced" | "safest";
  path: LatLng[];
}

/** The three standard options plus the rider's own edited route. */
export type MapRouteKind = SelectedRouteDisplay["kind"] | "custom";

export interface MapRoute {
  kind: MapRouteKind;
  path: LatLng[];
  description: RouteDescription;
}

export interface RoutePopup {
  kind: MapRouteKind;
  /** Where the route was clicked - the popup opens there. */
  position: LatLng;
  /**
   * Other routes running along the same street at the click point. Where
   * two options share a stretch only the top line can take the click, so
   * the popup offers the others rather than leaving them unreachable.
   */
  alsoHere: MapRouteKind[];
}

/** How close another route must run to the click to count as "also here". */
const SHARED_STREET_METERS = 15;

interface MapViewProps {
  center: LatLng;
  isLoaded: boolean;
  origin?: LatLng | null;
  destination?: LatLng | null;
  /**
   * Every route still on screen. All are drawn - the selected one bold and
   * on top, the rest lighter beneath - and each can be clicked to see what
   * kind of route it is, or removed from the map.
   */
  routes?: MapRoute[];
  selectedKind?: MapRouteKind | null;
  /** True once a route is selected: only it is on the map. */
  focused?: boolean;
  popup?: RoutePopup | null;
  onRouteClick?: (popup: RoutePopup) => void;
  onPopupClose?: () => void;
  onSelectRoute?: (kind: MapRouteKind) => void;
  onExitSelection?: () => void;
  onRemoveRoute?: (kind: MapRouteKind) => void;
  /**
   * Edit mode: clicks on the map (or the route) add a stop, stops can be
   * dragged, and clicking a stop removes it. `ghostPath` is the route
   * being edited as it was, drawn faintly for comparison.
   */
  editing?: boolean;
  waypoints?: LatLng[];
  ghostPath?: LatLng[] | null;
  onAddStop?: (at: LatLng) => void;
  onMoveStop?: (index: number, to: LatLng) => void;
  onRemoveStop?: (index: number) => void;
  /**
   * "Neighborhood view" - translucent circles over the same danger zones
   * used for route-risk scoring (see `computeCompositeDangerZones`). Not
   * shown by default (the app opens on a stock, uncluttered map), only
   * rendered when a non-empty `dangerZones` list is passed in.
   */
  dangerZones?: DangerZone[];
  /**
   * Neighbourhood-scale flagged areas (lib/data/sfDangerousNeighborhoods.ts),
   * drawn under the crash-cluster zones and labelled by name. Separate prop
   * rather than merged into `dangerZones` because the two mean different
   * things at different scales and the user toggles them independently.
   */
  dangerousNeighborhoods?: DangerousNeighborhood[];
  /**
   * Optional colored safety road-network overlay - not shown by default
   * (the app opens on a stock, uncluttered map), only rendered when a
   * non-empty `roadSegments` list is actually passed in.
   */
  roadSegments?: RoadSafetySegment[];
  activeLayer?: MapLayerId;
  selectedSegmentId?: string | null;
  onSegmentClick?: (segment: RoadSafetySegment) => void;
}

const containerStyle = { width: "100%", height: "100%" };

const mapOptions: google.maps.MapOptions = {
  disableDefaultUI: false,
  clickableIcons: false,
  streetViewControl: false,
  mapTypeControl: false,
  styles: [{ featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] }],
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Green -> yellow -> red gradient for a 0-100 "danger" score. Shared by the
 * road-safety overlay (every road is scored, including safe ones, so the
 * full range matters there) and the "neighborhood view" danger-zone circles
 * below (which only ever show zones already above the danger threshold, so
 * in practice those all land in the orange/red end of this same gradient).
 */
function dangerColor(score: number): string {
  const t = Math.max(0, Math.min(100, score)) / 100;
  const r = t < 0.5 ? lerp(34, 234, t * 2) : 234;
  const g = t < 0.5 ? 197 : lerp(179, 68, (t - 0.5) * 2);
  const b = t < 0.5 ? 94 : 40;
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * Line thickness by real road classification ("the size of the road"),
 * independent of its safety score - a freeway is drawn as a wide road
 * whether it scores safe or dangerous, same as a real map would.
 */
const ROAD_WIDTH_BY_KIND: Record<RoadKind, number> = {
  freeway: 9,
  arterial: 6,
  bikeLane: 4,
};

// Fastest stays a neutral gray - it's the baseline we compare against, not
// a recommendation. Safer is amber (a reasonable middle ground), safest is
// green (safety above all else).
const ROUTE_COLOR_BY_KIND: Record<MapRouteKind, string> = {
  fastest: "#64748b",
  balanced: "#f59e0b",
  safest: "#16a34a",
  // The rider's own route - distinct from every stock option.
  custom: "#7c3aed",
};

function toLatLng(e: google.maps.MapMouseEvent): LatLng | null {
  return e.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null;
}

function scoreForLayer(factorScores: DangerFactorScores, overall: number, layer: MapLayerId): number {
  switch (layer) {
    case "neighborhoodSafety":
      return factorScores.crashDensity;
    case "bikeInfrastructure":
      return factorScores.bikeInfrastructure;
    case "highwayExposure":
      return factorScores.highwayExposure;
    case "overallSafety":
    default:
      return overall;
  }
}

export default function MapView({
  center,
  isLoaded,
  origin,
  destination,
  routes = [],
  selectedKind = null,
  focused = false,
  popup = null,
  onRouteClick,
  onPopupClose,
  onSelectRoute,
  onExitSelection,
  onRemoveRoute,
  editing = false,
  waypoints = [],
  ghostPath = null,
  onAddStop,
  onMoveStop,
  onRemoveStop,
  dangerZones = [],
  dangerousNeighborhoods = [],
  roadSegments = [],
  activeLayer = "overallSafety",
  selectedSegmentId = null,
  onSegmentClick,
}: MapViewProps) {
  const lines = useMemo(
    () =>
      roadSegments.map((segment) => ({
        segment,
        score: scoreForLayer(segment.factorScores, segment.score, activeLayer),
      })),
    [roadSegments, activeLayer]
  );

  if (!isLoaded) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500">
        Loading map…
      </div>
    );
  }

  return (
    <GoogleMap
      mapContainerStyle={containerStyle}
      center={center}
      zoom={13}
      options={editing ? { ...mapOptions, draggableCursor: "crosshair" } : mapOptions}
      onClick={(e) => {
        const at = toLatLng(e);
        if (editing && at) onAddStop?.(at);
      }}
    >
      {dangerousNeighborhoods.map((area) => (
        <CircleF
          key={area.id}
          center={area.center}
          radius={area.radiusMeters}
          options={{
            fillColor: neighborhoodRiskColor(area.risk),
            fillOpacity: 0.16,
            strokeColor: neighborhoodRiskColor(area.risk),
            strokeOpacity: 0.65,
            strokeWeight: 2,
            clickable: false,
            // Below the crash-cluster zones (5) so the finer-grained
            // hotspots stay readable on top of the district wash.
            zIndex: 2,
          }}
        />
      ))}

      {dangerousNeighborhoods.map((area) => (
        <OverlayViewF
          key={`${area.id}-label`}
          position={area.center}
          mapPaneName="overlayMouseTarget"
          getPixelPositionOffset={(w, h) => ({ x: -(w / 2), y: -(h / 2) })}
        >
          <span
            className="pointer-events-none select-none whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-900"
            style={{
              // A plain text label vanishes against the basemap at some
              // zooms and against the fill at others; a translucent plate
              // keeps it legible over both.
              background: "rgba(255,255,255,0.82)",
              border: `1px solid ${neighborhoodRiskColor(area.risk)}`,
            }}
          >
            {area.name}
          </span>
        </OverlayViewF>
      ))}

      {dangerZones.map((zone) => (
        <CircleF
          key={zone.id}
          center={zone.center}
          radius={zone.radiusMeters}
          options={{
            fillColor: dangerColor(zone.weight),
            fillOpacity: 0.28,
            strokeColor: dangerColor(zone.weight),
            strokeOpacity: 0.75,
            strokeWeight: 1.5,
            clickable: false,
            zIndex: 5,
          }}
        />
      ))}

      {lines.map(({ segment, score }) => {
        const isSelected = segment.id === selectedSegmentId;
        const baseWidth = ROAD_WIDTH_BY_KIND[segment.kind];
        return (
          <PolylineF
            key={segment.id}
            path={segment.path}
            onClick={() => onSegmentClick?.(segment)}
            options={{
              strokeColor: isSelected ? "#1d4ed8" : dangerColor(score),
              strokeOpacity: 0.9,
              strokeWeight: isSelected ? baseWidth + 3 : baseWidth,
              clickable: true,
              zIndex: isSelected ? 20 : ROAD_WIDTH_BY_KIND[segment.kind],
            }}
          />
        );
      })}

      {routes
        .filter((route) => route.path.length > 1)
        .map((route) => {
          const isSelected = route.kind === selectedKind;
          const click = (e: google.maps.MapMouseEvent) => {
            const position = toLatLng(e) ?? route.path[Math.floor(route.path.length / 2)];
            // While editing, the route line is the most natural place to
            // click - so it adds a stop there instead of opening the popup.
            if (editing) {
              onAddStop?.(position);
              return;
            }
            onRouteClick?.({
              kind: route.kind,
              position,
              alsoHere: routes
                .filter((o) => o.kind !== route.kind && distanceToPath(position, o.path) <= SHARED_STREET_METERS)
                .map((o) => o.kind),
            });
          };
          return [
            <PolylineF
              key={`${route.kind}-line`}
              path={route.path}
              options={{
                strokeColor: ROUTE_COLOR_BY_KIND[route.kind],
                strokeOpacity: isSelected ? 0.95 : 0.55,
                strokeWeight: isSelected ? 6 : 4,
                clickable: false,
                zIndex: isSelected ? 32 : 30,
              }}
            />,
            // A 5px line is a hard target, especially on a phone. A wide,
            // nearly invisible twin catches the click instead.
            <PolylineF
              key={`${route.kind}-hit`}
              path={route.path}
              onClick={click}
              options={{
                strokeColor: ROUTE_COLOR_BY_KIND[route.kind],
                strokeOpacity: 0.01,
                strokeWeight: 18,
                clickable: true,
                zIndex: isSelected ? 33 : 31,
              }}
            />,
          ];
        })}

      {popup &&
        (() => {
          const route = routes.find((r) => r.kind === popup.kind);
          if (!route) return null;
          const d = route.description;
          return (
            <InfoWindowF position={popup.position} onCloseClick={onPopupClose}>
              <div className="flex max-w-60 flex-col gap-1.5 text-xs text-slate-900" data-testid="route-popup">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: ROUTE_COLOR_BY_KIND[route.kind] }}
                  />
                  {d.title}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {d.choices.map((c) => (
                    <li key={c.text} className={c.honoured ? "text-emerald-700" : "text-slate-500"}>
                      {c.honoured ? "✓" : "✕"} {c.text}
                    </li>
                  ))}
                </ul>
                <p className="text-slate-600">{d.stats.join(" · ")}</p>
                {popup.alsoHere.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1 text-slate-600">
                    Also on this street:
                    {popup.alsoHere.map((k) => {
                      const other = routes.find((r) => r.kind === k);
                      return other ? (
                        <button
                          key={k}
                          type="button"
                          onClick={() =>
                            onRouteClick?.({
                              kind: k,
                              position: popup.position,
                              alsoHere: [popup.kind, ...popup.alsoHere.filter((x) => x !== k)],
                            })
                          }
                          className="rounded border px-1.5 py-0.5 font-medium text-slate-900"
                          style={{ borderColor: ROUTE_COLOR_BY_KIND[k] }}
                        >
                          {other.description.title}
                        </button>
                      ) : null;
                    })}
                  </p>
                )}
                <div className="mt-1 flex gap-1.5">
                  {focused ? (
                    <button
                      type="button"
                      onClick={() => onExitSelection?.()}
                      className="rounded border border-slate-300 px-2 py-1 font-medium"
                    >
                      Show all routes
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelectRoute?.(route.kind)}
                        className="rounded bg-slate-900 px-2 py-1 font-semibold text-white"
                      >
                        Select this route
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveRoute?.(route.kind)}
                        className="rounded border border-slate-300 px-2 py-1 font-medium"
                      >
                        Remove from map
                      </button>
                    </>
                  )}
                </div>
              </div>
            </InfoWindowF>
          );
        })()}

      {editing && ghostPath && ghostPath.length > 1 && (
        <PolylineF
          path={ghostPath}
          options={{
            strokeColor: "#334155",
            strokeOpacity: 0,
            clickable: false,
            zIndex: 29,
            // Dashed: Google Maps has no dash style, so it is drawn as a
            // repeating symbol - "the route as it was", for comparison.
            icons: [
              {
                icon: { path: "M 0,-1 0,1", strokeOpacity: 0.55, strokeWeight: 3, scale: 3 },
                offset: "0",
                repeat: "14px",
              },
            ],
          }}
        />
      )}

      {editing &&
        waypoints.map((w, i) => (
          <MarkerF
            key={`stop-${i}-${w.lat}-${w.lng}`}
            position={w}
            draggable
            title={`Stop ${i + 1} - drag to move, click to remove`}
            label={{ text: String(i + 1), color: "white", fontWeight: "700" }}
            icon={{
              path: 0, // google.maps.SymbolPath.CIRCLE
              scale: 11,
              fillColor: ROUTE_COLOR_BY_KIND.custom,
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            }}
            onClick={() => onRemoveStop?.(i)}
            onDragEnd={(e) => {
              const at = toLatLng(e);
              if (at) onMoveStop?.(i, at);
            }}
          />
        ))}

      {origin && <MarkerF position={origin} label={{ text: "A", color: "white" }} />}
      {destination && <MarkerF position={destination} label={{ text: "B", color: "white" }} />}
    </GoogleMap>
  );
}
