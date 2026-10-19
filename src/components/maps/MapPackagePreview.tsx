import { useEffect, useMemo, useRef, useState } from "react";
import {
  mapLabelAnchor,
  type MapPackage,
  type PackagePoint,
} from "../../lib/mapPackage.mjs";

export function MapPackagePreview({
  map,
  selectedKey,
  onSelect,
  backgroundUrl,
  editMode = false,
  snap = false,
  onPolygonChange,
}: {
  map: Pick<MapPackage, "title" | "canvas" | "categories" | "plots">;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  backgroundUrl?: string;
  editMode?: boolean;
  snap?: boolean;
  onPolygonChange?: (points: PackagePoint[]) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ x: 50, y: 50 });
  const [showSource, setShowSource] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const drag = useRef<{
    x: number;
    y: number;
    center: { x: number; y: number };
  } | null>(null);
  const moved = useRef(false);
  const vertex = useRef<number | null>(null);
  const downKey = useRef<string | null>(null);
  const ratio = map.canvas.height / map.canvas.width;
  const categories = useMemo(
    () => new Map(map.categories.map((c) => [c.key, c])),
    [map.categories],
  );
  const width = 100 / zoom,
    height = (100 * ratio) / zoom;
  const pixelsPerUnit = Math.min(
    viewport.width / width,
    viewport.height / height,
  );
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const update = () => {
      const r = svg.getBoundingClientRect();
      if (r.width && r.height)
        setViewport({ width: r.width, height: r.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const viewBox = `${center.x - width / 2} ${center.y * ratio - height / 2} ${width} ${height}`;
  function locate() {
    const plot = map.plots.find((p) => p.key === selectedKey);
    if (!plot) return;
    const xs = plot.polygon.map((p) => p.x),
      ys = plot.polygon.map((p) => p.y);
    const left = Math.min(...xs),
      right = Math.max(...xs),
      top = Math.min(...ys),
      bottom = Math.max(...ys);
    setCenter({ x: (left + right) / 2, y: (top + bottom) / 2 });
    setZoom(
      Math.min(20, Math.max(1, 60 / Math.max(right - left, bottom - top))),
    );
  }
  function changeZoom(next: number) {
    const z = Math.max(1, Math.min(20, next));
    setZoom(z);
    setCenter(c => ({x: Math.max(50/z,Math.min(100-50/z,c.x)),y:Math.max(50/z,Math.min(100-50/z,c.y))}));
  }
  function moveVertex(clientX: number, clientY: number) {
    const matrix = svgRef.current?.getScreenCTM();
    const plot = map.plots.find((p) => p.key === selectedKey);
    if (!matrix || !plot || vertex.current === null || !onPolygonChange) return;
    const point = new DOMPoint(clientX, clientY).matrixTransform(
      matrix.inverse(),
    );
    const clamp = (value: number) =>
      Math.max(0, Math.min(100, snap ? Math.round(value * 4) / 4 : value));
    onPolygonChange(
      plot.polygon.map((p, i) =>
        i === vertex.current
          ? { x: clamp(point.x), y: clamp(point.y / ratio) }
          : p,
      ),
    );
  }
  return (
    <div className="package-map-preview">
      <div
        className="package-map-toolbar my-3 flex flex-wrap items-center gap-2 text-sm [&_button]:min-h-10 [&_button]:rounded-md [&_button]:border [&_button]:px-3 [&_button:disabled]:opacity-50"
        aria-label="Map controls"
      >
        <button
          type="button"
          onClick={() => changeZoom(zoom / 1.5)}
          aria-label="Zoom out"
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => changeZoom(zoom * 1.5)}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setCenter({ x: 50, y: 50 });
          }}
        >
          Full plan
        </button>
        <button type="button" disabled={!selectedKey} onClick={locate}>
          Locate selection
        </button>
        {(map.canvas.background || backgroundUrl) && (
          <label>
            <input
              type="checkbox"
              checked={showSource}
              onChange={(e) => setShowSource(e.target.checked)}
            />{" "}
            Original image
          </label>
        )}
      </div>
      <svg
        ref={svgRef}
        role="img"
        aria-label={`${map.title}, ${map.plots.length} plot outlines`}
        viewBox={viewBox}
        style={{
          width: "100%",
          aspectRatio: `${map.canvas.width} / ${map.canvas.height}`,
          maxHeight: 650,
          minHeight: 280,
          background: "#f7faf8",
          border: "1px solid #d4ded8",
          borderRadius: 12,
          touchAction: zoom > 1 || editMode ? "none" : "pan-y",
          cursor: zoom > 1 ? "grab" : "default",
        }}
        onPointerDown={(e) => {
          moved.current = false;
          downKey.current = (e.target as Element).closest("[data-map-plot]")?.getAttribute("data-map-plot") ?? null;
          if (zoom <= 1) return;
          drag.current = { x: e.clientX, y: e.clientY, center };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (vertex.current !== null) {
            moveVertex(e.clientX, e.clientY);
            return;
          }
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x,
            dy = e.clientY - drag.current.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) moved.current = true;
          setCenter({
            x: Math.max(
              width / 2,
              Math.min(
                100 - width / 2,
                drag.current.center.x - dx / pixelsPerUnit,
              ),
            ),
            y: Math.max(
              50 / zoom,
              Math.min(
                100 - 50 / zoom,
                drag.current.center.y - dy / pixelsPerUnit / ratio,
              ),
            ),
          });
        }}
        onPointerUp={() => {
          if (downKey.current && !moved.current && vertex.current===null) onSelect(downKey.current);
          drag.current = null;
          vertex.current = null;
          downKey.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
          vertex.current = null;
          downKey.current = null;
        }}
      >
        {showSource && (map.canvas.background || backgroundUrl) && (
          <image
            href={
              map.canvas.background
                ? `data:${map.canvas.background.mime};base64,${map.canvas.background.data_base64}`
                : backgroundUrl
            }
            x="0"
            y="0"
            width="100"
            height={100 * ratio}
          />
        )}
        {map.plots.map((plot, i) => {
          const xs = plot.polygon.map((p) => p.x),
            ys = plot.polygon.map((p) => p.y);
          const font = 14 / pixelsPerUnit;
          const label = plot.number || `Ref ${i + 1}`;
          const anchor =
            Math.max(...xs) - Math.min(...xs) > label.length * font * 0.65 &&
            (Math.max(...ys) - Math.min(...ys)) * ratio > font * 1.4
              ? mapLabelAnchor(
                  plot.polygon.map((p) => ({ x: p.x, y: p.y * ratio })),
                  label.length * font * 0.65,
                  font * 1.4,
                )
              : null;
          return (
            <g
              key={plot.key}
              data-map-plot={plot.key}
              style={{ cursor: "pointer" }}
            >
              <polygon
                points={plot.polygon
                  .map((p) => `${p.x},${p.y * ratio}`)
                  .join(" ")}
                fill={
                  categories.get(plot.category_key ?? "")?.color ?? "#d5e3da"
                }
                fillOpacity={
                  showSource && (map.canvas.background || backgroundUrl)
                    ? 0.65
                    : 1
                }
                stroke={selectedKey === plot.key ? "#1647bd" : "#476252"}
                strokeWidth={selectedKey === plot.key ? 3 : 1}
                vectorEffect="non-scaling-stroke"
              />
              {anchor && (
                <text
                  x={anchor.x}
                  y={anchor.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={font}
                  fontWeight={650}
                  fill="#142b20"
                  stroke="white"
                  strokeWidth={font * 0.18}
                  paintOrder="stroke"
                  style={{ pointerEvents: "none" }}
                >
                  {label}
                </text>
              )}
              <title>
                {label}
                {plot.area_value !== null
                  ? ` · ${plot.area_value} ${plot.area_unit}`
                  : ""}
              </title>
              {editMode &&
                onPolygonChange &&
                selectedKey === plot.key &&
                plot.polygon.map((p, index) => (
                  <circle
                    key={index}
                    cx={p.x}
                    cy={p.y * ratio}
                    r={7 / pixelsPerUnit}
                    fill="white"
                    stroke="#1647bd"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    style={{ touchAction: "none", cursor: "move" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      vertex.current = index;
                      moved.current = true;
                      svgRef.current?.setPointerCapture(e.pointerId);
                    }}
                  />
                ))}
            </g>
          );
        })}
      </svg>
      <p className="package-map-caption">
        Click an outline or choose it from the plot list. Area values come from
        the plot record.
      </p>
    </div>
  );
}
