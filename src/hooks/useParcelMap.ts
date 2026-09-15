import { useCallback, useState } from "react";

/**
 * Parcel boundary map model.
 *
 * Coordinates are percentages (0-100) relative to the masterplan image
 * width/height so polygons stay responsive at any viewport size.
 * Mirrors `public.parcels.map_polygon` (jsonb array of {x, y}).
 */
export interface MapPoint {
  x: number;
  y: number;
}

export type ParcelMapMode = "view" | "draw" | "edit";

/** Click-within radius (percentage units) that auto-closes a drawn polygon. */
export const CLOSE_THRESHOLD_PCT = 2.5;

/** Snap step in percentage units when snap-to-grid is enabled. */
export const SNAP_GRID_STEP_PCT = 1;

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function clampMapPoint(point: MapPoint): MapPoint {
  return { x: clampPct(point.x), y: clampPct(point.y) };
}

/**
 * Convert a click pixel position on the canvas/SVG container to responsive
 * percentage coordinates.
 */
export function normalizePixelToPercent(
  pixelX: number,
  pixelY: number,
  imageWidth: number,
  imageHeight: number,
): MapPoint {
  if (!imageWidth || !imageHeight) return { x: 0, y: 0 };
  return {
    x: clampPct((pixelX / imageWidth) * 100),
    y: clampPct((pixelY / imageHeight) * 100),
  };
}

/** Inverse of normalizePixelToPercent: percentages back to pixels. */
export function denormalizePercentToPixel(
  point: MapPoint,
  imageWidth: number,
  imageHeight: number,
): { pixelX: number; pixelY: number } {
  return {
    pixelX: (clampPct(point.x) / 100) * imageWidth,
    pixelY: (clampPct(point.y) / 100) * imageHeight,
  };
}

export function snapPointToGrid(point: MapPoint, step: number = SNAP_GRID_STEP_PCT): MapPoint {
  if (!step || step <= 0) return clampMapPoint(point);
  return {
    x: clampPct(Math.round(point.x / step) * step),
    y: clampPct(Math.round(point.y / step) * step),
  };
}

export function sanitizePolygon(input: MapPoint[] | null | undefined): MapPoint[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map(clampMapPoint)
    .slice(0, 200);
}

/** "x1,y1 x2,y2 ..." attribute value for SVG <polygon>/<polyline>. */
export function pointsToSvgPoints(points: MapPoint[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

export function distancePct(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isNearFirstPoint(points: MapPoint[], candidate: MapPoint): boolean {
  if (points.length < 3) return false;
  return distancePct(points[0], candidate) <= CLOSE_THRESHOLD_PCT;
}

export function isClosedPolygon(points: MapPoint[]): boolean {
  return points.length >= 3;
}

export interface UseParcelMapOptions {
  initialPoints?: MapPoint[] | null;
  initialMode?: ParcelMapMode;
  snapToGrid?: boolean;
}

export interface UseParcelMapResult {
  points: MapPoint[];
  mode: ParcelMapMode;
  snapEnabled: boolean;
  selectedVertex: number | null;
  closed: boolean;
  setMode: (mode: ParcelMapMode) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setSelectedVertex: (index: number | null) => void;
  /** Add an already-normalized percentage point (applies snap + clamp). */
  addPoint: (point: MapPoint) => void;
  /** Convert click pixels to percentages (with snap) and append. */
  addPointFromPixels: (pixelX: number, pixelY: number, imageWidth: number, imageHeight: number) => void;
  updatePoint: (index: number, point: MapPoint) => void;
  moveVertex: (index: number, point: MapPoint) => void;
  removePoint: (index: number) => void;
  removeVertex: (index: number) => void;
  clearPolygon: () => void;
  loadPolygon: (next: MapPoint[] | null | undefined) => void;
  setPoints: (next: MapPoint[]) => void;
}

export function useParcelMap(options: UseParcelMapOptions = {}): UseParcelMapResult {
  const [points, setPointsState] = useState<MapPoint[]>(() => sanitizePolygon(options.initialPoints));
  const [mode, setMode] = useState<ParcelMapMode>(options.initialMode ?? "view");
  const [snapEnabled, setSnapEnabled] = useState<boolean>(options.snapToGrid ?? false);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);

  const setPoints = useCallback((next: MapPoint[]) => {
    setPointsState(sanitizePolygon(next));
  }, []);

  const loadPolygon = useCallback((next: MapPoint[] | null | undefined) => {
    setPointsState(sanitizePolygon(next));
    setSelectedVertex(null);
  }, []);

  const applySnap = useCallback(
    (point: MapPoint): MapPoint => {
      const clamped = clampMapPoint(point);
      return snapEnabled ? snapPointToGrid(clamped) : clamped;
    },
    [snapEnabled],
  );

  const addPoint = useCallback(
    (point: MapPoint) => {
      setPointsState((current) => [...current, applySnap(point)].slice(0, 200));
    },
    [applySnap],
  );

  const addPointFromPixels = useCallback(
    (pixelX: number, pixelY: number, imageWidth: number, imageHeight: number) => {
      addPoint(normalizePixelToPercent(pixelX, pixelY, imageWidth, imageHeight));
    },
    [addPoint],
  );

  const updatePoint = useCallback(
    (index: number, point: MapPoint) => {
      setPointsState((current) => {
        if (index < 0 || index >= current.length) return current;
        const next = [...current];
        next[index] = applySnap(point);
        return next;
      });
    },
    [applySnap],
  );

  const moveVertex = useCallback(
    (index: number, point: MapPoint) => {
      updatePoint(index, point);
    },
    [updatePoint],
  );

  const removePoint = useCallback((index: number) => {
    setPointsState((current) => {
      if (index < 0 || index >= current.length) return current;
      return current.filter((_, i) => i !== index);
    });
    setSelectedVertex((current) => (current === index ? null : current));
  }, []);

  const removeVertex = useCallback(
    (index: number) => {
      removePoint(index);
    },
    [removePoint],
  );

  const clearPolygon = useCallback(() => {
    setPointsState([]);
    setSelectedVertex(null);
  }, []);

  return {
    points,
    mode,
    snapEnabled,
    selectedVertex,
    closed: isClosedPolygon(points),
    setMode,
    setSnapEnabled,
    setSelectedVertex,
    addPoint,
    addPointFromPixels,
    updatePoint,
    moveVertex,
    removePoint,
    removeVertex,
    clearPolygon,
    loadPolygon,
    setPoints,
  };
}
