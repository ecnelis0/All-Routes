"use client";

import { Circle, GoogleMap, Marker, OverlayView, Polyline } from "@react-google-maps/api";
import {
  neighborhoodRiskColor,
  type DangerousNeighborhood,
} from "@/lib/data/sfDangerousNeighborhoods";
import { useMemo } from "react";
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
  kind: RouteOptionKind;
  path: LatLng[];
}

interface MapViewProps {
  center: LatLng;
  isLoaded: boolean;
  origin?: LatLng | null;
  destination?: LatLng | null;
  /** The single route currently shown on the map - the UI lets the user switch between the 3 route options, and only the active one is drawn at a time. */
  selectedRoute?: SelectedRouteDisplay | null;
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

// Fastest (Google's own route) stays a neutral gray - it's the baseline,
// not a recommendation. Overall-best is amber (a reasonable middle ground),
// absolute-safest is green (safety above all else).
const ROUTE_COLOR_BY_KIND: Record<RouteOptionKind, string> = {
  fastest: "#64748b",
  balancedSafe: "#f59e0b",
  safest: "#16a34a",
};

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
  selectedRoute,
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
    <GoogleMap mapContainerStyle={containerStyle} center={center} zoom={13} options={mapOptions}>
      {dangerousNeighborhoods.map((area) => (
        <Circle
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
        <OverlayView
          key={`${area.id}-label`}
          position={area.center}
          mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
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
        </OverlayView>
      ))}

      {dangerZones.map((zone) => (
        <Circle
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
          <Polyline
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

      {selectedRoute && selectedRoute.path.length > 1 && (
        <Polyline
          path={selectedRoute.path}
          options={{
            strokeColor: ROUTE_COLOR_BY_KIND[selectedRoute.kind],
            strokeOpacity: 0.95,
            strokeWeight: 5,
            zIndex: 30,
          }}
        />
      )}

      {origin && <Marker position={origin} label={{ text: "A", color: "white" }} />}
      {destination && <Marker position={destination} label={{ text: "B", color: "white" }} />}
    </GoogleMap>
  );
}
