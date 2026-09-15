import { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/utils";
import { money } from "../../../lib/utils";
import type { ParcelStatus } from "../../../types/database";
import {
  CLOSE_THRESHOLD_PCT,
  distancePct,
  pointsToSvgPoints,
  type MapPoint,
  type ParcelMapMode,
} from "../../../hooks/useParcelMap";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";

export interface CanvasParcel {
  id: number;
  lot_number: string;
  status: ParcelStatus;
  base_price: number;
  dimensions: string | null;
  map_polygon: MapPoint[] | null;
}

interface ParcelMapCanvasProps {
  imageUrl: string | null;
  parcels: CanvasParcel[];
  activeParcelId: number | null;
  draftPolygon: MapPoint[];
  mode: ParcelMapMode;
  snapEnabled: boolean;
  selectedVertex: number | null;
  saving?: boolean;
  onModeChange: (mode: ParcelMapMode) => void;
  onSnapChange: (enabled: boolean) => void;
  onAddPoint: (point: MapPoint) => void;
  onUpdatePoint: (index: number, point: MapPoint) => void;
  onRemovePoint: (index: number) => void;
  onSelectVertex: (index: number | null) => void;
  onSelectParcel: (parcelId: number | null) => void;
  onClear: () => void;
  onSave: () => void;
}

const STATUS_STYLE: Record<ParcelStatus, { fill: string; stroke: string; label: string }> = {
  Available: { fill: "#22c55e", stroke: "#15803d", label: "Available" },
  Reserved: { fill: "#f59e0b", stroke: "#b45309", label: "Reserved" },
  Sold: { fill: "#ef4444", stroke: "#b91c1c", label: "Sold" },
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

function styleFor(status: ParcelStatus) {
  return STATUS_STYLE[status] ?? STATUS_STYLE.Available;
}

export function ParcelMapCanvas({
  imageUrl,
  parcels,
  activeParcelId,
  draftPolygon,
  mode,
  snapEnabled,
  selectedVertex,
  saving = false,
  onModeChange,
  onSnapChange,
  onAddPoint,
  onUpdatePoint,
  onRemovePoint,
  onSelectVertex,
  onSelectParcel,
  onClear,
  onSave,
}: ParcelMapCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draggingVertex, setDraggingVertex] = useState<number | null>(null);

  const viewBox = useMemo(() => {
    const w = 100 / zoom;
    const h = 100 / zoom;
    const x = Math.min(100 - w, Math.max(0, pan.x));
    const y = Math.min(100 - h, Math.max(0, pan.y));
    return `${x} ${y} ${w} ${h}`;
  }, [zoom, pan]);

  const activeParcel = parcels.find((p) => p.id === activeParcelId) ?? null;

  const toPercent = useCallback(
    (clientX: number, clientY: number): MapPoint | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const viewW = 100 / zoom;
      const viewH = 100 / zoom;
      const viewX = Math.min(100 - viewW, Math.max(0, pan.x));
      const viewY = Math.min(100 - viewH, Math.max(0, pan.y));
      return {
        x: Math.min(100, Math.max(0, viewX + ((clientX - rect.left) / rect.width) * viewW)),
        y: Math.min(100, Math.max(0, viewY + ((clientY - rect.top) / rect.height) * viewH)),
      };
    },
    [zoom, pan],
  );

  const handleSvgClick = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (mode !== "draw") return;
      if (draggingVertex !== null) return;
      const point = toPercent(event.clientX, event.clientY);
      if (!point) return;
      // Auto-close: clicking near the origin with 3+ vertices finishes the shape.
      if (draftPolygon.length >= 3 && distancePct(draftPolygon[0], point) <= CLOSE_THRESHOLD_PCT) {
        onModeChange("edit");
        return;
      }
      onAddPoint(point);
    },
    [mode, draggingVertex, toPercent, draftPolygon, onAddPoint, onModeChange],
  );

  const handleVertexPointerDown = useCallback(
    (event: React.PointerEvent<SVGCircleElement>, index: number) => {
      if (mode !== "edit") return;
      event.stopPropagation();
      event.preventDefault();
      setDraggingVertex(index);
      onSelectVertex(index);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [mode, onSelectVertex],
  );

  const handleVertexPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (mode !== "edit" || draggingVertex === null) return;
      const point = toPercent(event.clientX, event.clientY);
      if (!point) return;
      onUpdatePoint(draggingVertex, point);
    },
    [mode, draggingVertex, toPercent, onUpdatePoint],
  );

  const endVertexDrag = useCallback(() => {
    setDraggingVertex(null);
  }, []);

  const zoomBy = useCallback(
    (delta: number) => {
      setZoom((current) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + delta));
        if (next === MIN_ZOOM) setPan({ x: 0, y: 0 });
        return next;
      });
    },
    [],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setPan((current) => {
        const viewW = 100 / zoom;
        const viewH = 100 / zoom;
        return {
          x: Math.min(100 - viewW, Math.max(0, current.x + dx)),
          y: Math.min(100 - viewH, Math.max(0, current.y + dy)),
        };
      });
    },
    [zoom],
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border" role="tablist" aria-label="Map mode">
          {(["view", "draw", "edit"] as ParcelMapMode[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => onModeChange(value)}
              className={cn(
                "px-3 py-2 text-sm font-semibold capitalize transition",
                mode === value ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-primary",
              )}
            >
              {value === "view" ? "Select" : value === "draw" ? "Draw" : "Edit"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={snapEnabled} onChange={(event) => onSnapChange(event.target.checked)} />
          Snap-to-grid
        </label>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => zoomBy(-0.5)} disabled={zoom <= MIN_ZOOM}>
            Zoom out
          </Button>
          <Button type="button" variant="outline" onClick={() => zoomBy(0.5)} disabled={zoom >= MAX_ZOOM}>
            Zoom in
          </Button>
          <Button type="button" variant="ghost" onClick={resetView}>
            Reset view
          </Button>
        </span>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-border bg-muted">
        {imageUrl ? (
          <img src={imageUrl} alt="Subdivision masterplan" className="block h-auto w-full select-none" draggable={false} />
        ) : (
          <div className="grid aspect-[16/10] w-full place-items-center bg-muted p-6 text-center text-sm text-muted-foreground">
            No masterplan image configured. Set a site map URL to plot parcel boundaries against the aerial photo.
          </div>
        )}
        <svg
          ref={svgRef}
          viewBox={viewBox}
          preserveAspectRatio="none"
          className={cn("absolute inset-0 h-full w-full", mode === "draw" && "cursor-crosshair")}
          onClick={handleSvgClick}
          onPointerMove={handleVertexPointerMove}
          onPointerUp={endVertexDrag}
          onPointerLeave={endVertexDrag}
          role="application"
          aria-label="Parcel boundary map"
        >
          {parcels.map((parcel) => {
            const polygon = parcel.id === activeParcelId ? draftPolygon : (parcel.map_polygon ?? []);
            if (!polygon.length) return null;
            const style = styleFor(parcel.status);
            const isActive = parcel.id === activeParcelId;
            return (
              <g key={parcel.id}>
                <polygon
                  points={pointsToSvgPoints(polygon)}
                  fill={style.fill}
                  fillOpacity={isActive ? 0.45 : 0.35}
                  stroke={style.stroke}
                  strokeWidth={isActive ? 0.6 : 0.4}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: mode === "view" ? "pointer" : undefined }}
                  onClick={(event) => {
                    if (mode !== "view") return;
                    event.stopPropagation();
                    onSelectParcel(parcel.id);
                  }}
                >
                  <title>{`Lot ${parcel.lot_number} — ${parcel.status}`}</title>
                </polygon>
                {isActive && (mode === "draw" || mode === "edit")
                  ? polygon.map((point, index) => (
                      <circle
                        key={index}
                        cx={point.x}
                        cy={point.y}
                        r={0.9}
                        fill={selectedVertex === index ? "#1d4ed8" : "#ffffff"}
                        stroke={style.stroke}
                        strokeWidth={0.3}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: mode === "edit" ? "grab" : "pointer" }}
                        onPointerDown={(event) => handleVertexPointerDown(event, index)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectVertex(index);
                          if (event.detail === 2) onRemovePoint(index);
                        }}
                      >
                        <title>{`Vertex ${index + 1} (double-click to remove)`}</title>
                      </circle>
                    ))
                  : null}
              </g>
            );
          })}
        </svg>

        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1">
          {(Object.keys(STATUS_STYLE) as ParcelStatus[]).map((status) => (
            <span
              key={status}
              className="rounded-full bg-card/90 px-2 py-1 text-xs font-semibold text-foreground shadow-sm"
            >
              <span
                className="mr-1 inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STATUS_STYLE[status].fill }}
              />
              {STATUS_STYLE[status].label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => panBy(-5, 0)} disabled={zoom <= MIN_ZOOM}>
          ← Pan
        </Button>
        <Button type="button" variant="outline" onClick={() => panBy(5, 0)} disabled={zoom <= MIN_ZOOM}>
          Pan →
        </Button>
        <Button type="button" variant="outline" onClick={() => panBy(0, -5)} disabled={zoom <= MIN_ZOOM}>
          ↑ Pan
        </Button>
        <Button type="button" variant="outline" onClick={() => panBy(0, 5)} disabled={zoom <= MIN_ZOOM}>
          ↓ Pan
        </Button>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={onClear} disabled={!draftPolygon.length || saving}>
            Clear polygon
          </Button>
          <Button type="button" onClick={onSave} disabled={draftPolygon.length < 3 || saving}>
            {saving ? "Saving…" : `Save polygon (${draftPolygon.length} pts)`}
          </Button>
        </span>
      </div>

      {activeParcel ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3 text-sm">
          <strong className="text-primary">Lot {activeParcel.lot_number}</strong>
          <Badge tone={activeParcel.status === "Available" ? "green" : activeParcel.status === "Reserved" ? "amber" : "red"}>
            {activeParcel.status}
          </Badge>
          <span className="text-muted-foreground">{activeParcel.dimensions ?? "Size TBC"}</span>
          <span className="font-semibold text-primary">{money(activeParcel.base_price)}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {mode === "draw"
              ? "Click to add vertices. Click near the first point to finish."
              : mode === "edit"
                ? "Drag vertices to reshape. Double-click a vertex to remove it."
                : "Select a lot polygon to inspect it."}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {mode === "view"
            ? "Click any colored lot polygon to highlight it and view lot details."
            : "Select a lot first, then draw its boundary."}
        </p>
      )}
    </div>
  );
}
