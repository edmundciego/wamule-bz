/**
 * Buyer-contract-neutral coordinate and viewport primitives for map canvases.
 * Parcel identity, sale state, and editing policy deliberately live elsewhere.
 */
export interface MapCoordinate {
  x: number;
  y: number;
}

export interface MapPan {
  x: number;
  y: number;
}

export interface MapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapPanPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const NO_MAP_PAN_PADDING: Readonly<MapPanPadding> = Object.freeze({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
});

/** Geometry is stored in image-relative percentages; SVG height follows image aspect. */
export function mapViewBoxHeight(aspectRatio: number | null | undefined): number {
  return typeof aspectRatio === "number" && Number.isFinite(aspectRatio) && aspectRatio > 0
    ? 100 / aspectRatio
    : 100;
}

/** Render normalized image coordinates in the SVG map's aspect-corrected space. */
export function mapPolygonToSvgPoints(
  polygon: readonly MapCoordinate[],
  scale: { x?: number; y?: number } = {},
  precision?: number,
): string {
  const xScale = scale.x ?? 1;
  const yScale = scale.y ?? 1;
  return polygon.map(({ x, y }) => {
    const sx = x * xScale;
    const sy = y * yScale;
    return precision === undefined ? `${sx},${sy}` : `${sx.toFixed(precision)},${sy.toFixed(precision)}`;
  }).join(" ");
}

/** Convert image-relative percentage geometry to source-raster pixel coordinates. */
export function mapPolygonToRasterPixels(
  polygon: readonly MapCoordinate[],
  rasterWidth: number,
  rasterHeight: number,
): MapCoordinate[] {
  return polygon.map(({ x, y }) => ({ x: x * rasterWidth / 100, y: y * rasterHeight / 100 }));
}

export function mapPolygonBounds(polygon: readonly MapCoordinate[], yScale = 1): MapBounds | null {
  if (polygon.length === 0) return null;
  const xs = polygon.map(({ x }) => x);
  const ys = polygon.map(({ y }) => y * yScale);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Bounding-box area in normalized map units, useful only for draw ordering. */
export function mapPolygonBoundsArea(polygon: readonly MapCoordinate[]): number {
  if (polygon.length < 3) return 0;
  const bounds = mapPolygonBounds(polygon);
  return bounds ? bounds.width * bounds.height : 0;
}

export function clampMapPan(
  pan: MapPan,
  zoom: number,
  mapWidth: number,
  mapHeight: number,
  padding: Readonly<MapPanPadding> = NO_MAP_PAN_PADDING,
): MapPan {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const viewWidth = mapWidth / safeZoom;
  const viewHeight = mapHeight / safeZoom;
  const x = Math.min(Math.max(0, mapWidth - viewWidth) + padding.right, Math.max(-padding.left, pan.x));
  const y = Math.min(Math.max(0, mapHeight - viewHeight) + padding.bottom, Math.max(-padding.top, pan.y));
  return {
    x: x === 0 ? 0 : x,
    y: y === 0 ? 0 : y,
  };
}

export function mapViewportBounds(
  pan: MapPan,
  zoom: number,
  mapWidth: number,
  mapHeight: number,
  padding: Readonly<MapPanPadding> = NO_MAP_PAN_PADDING,
): MapBounds {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const position = clampMapPan(pan, safeZoom, mapWidth, mapHeight, padding);
  return { x: position.x, y: position.y, width: mapWidth / safeZoom, height: mapHeight / safeZoom };
}

export function mapViewBoxString(bounds: MapBounds): string {
  return `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`;
}

/** Keep a source-map coordinate under the same viewport point while zooming. */
export function mapPanAfterZoom(
  pan: MapPan,
  oldZoom: number,
  newZoom: number,
  focalPoint: MapCoordinate,
  mapWidth: number,
  mapHeight: number,
  padding: Readonly<MapPanPadding> = NO_MAP_PAN_PADDING,
): MapPan {
  const ratio = oldZoom / newZoom;
  return clampMapPan({
    x: focalPoint.x - (focalPoint.x - pan.x) * ratio,
    y: focalPoint.y - (focalPoint.y - pan.y) * ratio,
  }, newZoom, mapWidth, mapHeight, padding);
}

/** Invert an SVG viewBox transform, honoring xMidYMid meet or a stretched SVG. */
export function clientPointToMapCoordinate(
  clientX: number,
  clientY: number,
  rect: ClientRectLike,
  viewBox: MapBounds,
  aspect: "meet" | "none" = "meet",
): MapCoordinate | null {
  if (rect.width <= 0 || rect.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return null;
  if (aspect === "none") {
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
    };
  }
  const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = rect.left + (rect.width - viewBox.width * scale) / 2;
  const offsetY = rect.top + (rect.height - viewBox.height * scale) / 2;
  return {
    x: viewBox.x + (clientX - offsetX) / scale,
    y: viewBox.y + (clientY - offsetY) / scale,
  };
}
