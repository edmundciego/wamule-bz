export interface HopkinsDemoLabelParcel {
  lot_number: string;
  local_key: number;
  local_preview?: { parentDetectionId: string; childNumber: number };
}

export const STANDARD_MAP_LABEL_SCREEN_PX = 13;

export interface HopkinsSourceMapLabelParcel {
  local_key: number;
  demo_label?: string;
  source_printed_lot_number_candidate?: string | null;
  source_printed_lot_number_status?: string | null;
  map_polygon?: Array<{ x: number; y: number }> | null;
}

export interface HopkinsSourceMapLabelLayout {
  localKey: number;
  text: string;
  x: number;
  y: number;
  fontSize: number;
}

/**
 * Public map ink may use a printed identity only after source-image review.
 * Every other feature is explicitly presented as a generated map reference.
 */
export function hopkinsPublicMapLabel(parcel: HopkinsSourceMapLabelParcel): string | null {
  if (parcel.source_printed_lot_number_status === "source-image-cross-checked"
    && parcel.source_printed_lot_number_candidate
    && /^\d{1,5}$/.test(parcel.source_printed_lot_number_candidate)) {
    return parcel.source_printed_lot_number_candidate;
  }
  const reference = /^(?:Plot|Ref)\s+(\d{1,5})$/i.exec(parcel.demo_label ?? "")?.[1];
  return reference ? `Ref ${reference}` : null;
}

/** Keep generated public references visibly distinct from printed plan IDs. */
export function publicMapReferenceLabel(reference: string | null | undefined): string {
  if (!reference) return "Map reference";
  const match = /^(?:Plot|Ref)\s+(\d{1,5})$/i.exec(reference.trim());
  return match ? `Ref ${match[1]}` : reference;
}

/** Sparse generated references at broad views, filling in as lots enlarge. */
export function hopkinsMapReferenceInterval(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom < 2) return Number.POSITIVE_INFINITY;
  if (zoom < 3) return 16;
  if (zoom < 4) return 8;
  if (zoom < 5) return 4;
  if (zoom < 6) return 2;
  return 1;
}

function pointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if (!a || !b) continue;
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function labelAnchor(
  polygon: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const insetX = width / 2;
  const insetY = height / 2;
  if (right - left < width || bottom - top < height) return null;

  // Scan several horizontal slices. Their widest interior intervals provide
  // anchors for concave lots as well as the common rectangular outlines.
  const candidates: Array<{ x: number; y: number; score: number }> = [];
  // Printed lot IDs and areas are generally centered in the source drawing.
  // Prefer a quiet interior point near the top-left corner so generated Ref
  // labels do not sit over those source annotations.
  for (const fraction of [0.06, 0.1, 0.14, 0.2, 0.26, 0.33, 0.4, 0.5, 0.6, 0.7, 0.8, 0.86]) {
    const y = top + (bottom - top) * fraction;
    const crossings: number[] = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      if (!a || !b || (a.y > y) === (b.y > y)) continue;
      crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const leftEdge = crossings[index];
      const rightEdge = crossings[index + 1];
      if (leftEdge === undefined || rightEdge === undefined || rightEdge - leftEdge < width) continue;
      const xCandidates = [leftEdge + insetX + Math.min(0.03, (rightEdge - leftEdge - width) / 2), (leftEdge + rightEdge) / 2];
      for (const x of xCandidates) {
        if (x - insetX < left || x + insetX > right || y - insetY < top || y + insetY > bottom) continue;
        const corners = [
          { x: x - insetX, y: y - insetY }, { x: x + insetX, y: y - insetY },
          { x: x - insetX, y: y + insetY }, { x: x + insetX, y: y + insetY },
        ];
        if (corners.every((corner) => pointInPolygon(corner, polygon))) {
          const score = fraction * 10 + (x - left) / Math.max(right - left, 0.001);
          candidates.push({ x, y, score });
          break;
        }
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x);
  return candidates[0] ? { x: candidates[0].x, y: candidates[0].y } : null;
}

/**
 * Return crisp map labels whose estimated text boxes fit inside their own
 * outlines. Labels that would overlap are omitted until zoom makes room.
 */
export function layoutHopkinsSourceMapLabels(
  parcels: HopkinsSourceMapLabelParcel[],
  options: {
    yScale: number;
    screenPixelsPerMapUnit: number;
    selectedLocalKey?: number | null;
    hoveredLocalKey?: number | null;
    zoom: number;
    minimumZoom?: number;
    screenFontSize?: number;
    viewBox?: { x: number; y: number; width: number; height: number };
  },
): HopkinsSourceMapLabelLayout[] {
  const { yScale, screenPixelsPerMapUnit: scale } = options;
  if (!(yScale > 0) || !(scale > 0)) return [];
  const minZoom = options.minimumZoom ?? 1.12;
  const selectedKey = options.selectedLocalKey ?? null;
  const hoveredKey = options.hoveredLocalKey ?? null;
  if (options.zoom < minZoom && selectedKey === null && hoveredKey === null) return [];
  const referenceInterval = hopkinsMapReferenceInterval(options.zoom);
  const targetPx = options.screenFontSize ?? STANDARD_MAP_LABEL_SCREEN_PX;
  const ranked = parcels.map((parcel) => {
    const text = hopkinsPublicMapLabel(parcel);
    const focused = parcel.local_key === selectedKey || parcel.local_key === hoveredKey;
    const revealLabel = focused || (Number.isFinite(referenceInterval) && parcel.local_key % referenceInterval === 0);
    const polygon = Array.isArray(parcel.map_polygon) && parcel.map_polygon.length >= 3
      ? parcel.map_polygon.map((point) => ({ x: point.x, y: point.y * yScale }))
      : [];
    const xs = polygon.map((point) => point.x);
    const ys = polygon.map((point) => point.y);
    const bounds = polygon.length >= 3 ? {
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    } : null;
    const fontSize = text && bounds && revealLabel
      ? fitStandardMapLabelFontSize(bounds, text, scale, targetPx)
      : null;
    const anchor = text && fontSize && polygon.length >= 3
      ? labelAnchor(polygon, text.length * fontSize * 0.62, fontSize * 1.2)
      : null;
    const textWidth = text && fontSize ? text.length * fontSize * 0.62 : 0;
    const textHeight = fontSize ? fontSize * 1.2 : 0;
    const view = options.viewBox;
    const inView = !view || !anchor || (
      anchor.x - textWidth / 2 >= view.x
      && anchor.x + textWidth / 2 <= view.x + view.width
      && anchor.y - textHeight / 2 >= view.y
      && anchor.y + textHeight / 2 <= view.y + view.height
    );
    const priority = parcel.local_key === selectedKey ? 2 : parcel.local_key === hoveredKey ? 1 : 0;
    return { parcel, text, polygon, fontSize, anchor: inView ? anchor : null, priority };
  }).filter((item): item is typeof item & { text: string; fontSize: number; anchor: { x: number; y: number } } =>
    Boolean(item.text && item.fontSize && item.anchor))
    .sort((a, b) => b.priority - a.priority
      || Number(b.parcel.source_printed_lot_number_status === "source-image-cross-checked")
        - Number(a.parcel.source_printed_lot_number_status === "source-image-cross-checked")
      || b.polygon.length - a.polygon.length
      || a.parcel.local_key - b.parcel.local_key);

  const accepted: Array<HopkinsSourceMapLabelLayout & { left: number; right: number; top: number; bottom: number }> = [];
  const cellSize = Math.max(targetPx * 1.5, 16);
  const cells = new Map<string, number[]>();
  for (const item of ranked) {
    const width = item.text.length * item.fontSize * scale * 0.62 + 4;
    const height = item.fontSize * scale * 1.2 + 4;
    const cx = item.anchor.x * scale;
    const cy = item.anchor.y * scale;
    const left = cx - width / 2;
    const right = cx + width / 2;
    const top = cy - height / 2;
    const bottom = cy + height / 2;
    const leftCell = Math.floor(left / cellSize);
    const rightCell = Math.floor(right / cellSize);
    const topCell = Math.floor(top / cellSize);
    const bottomCell = Math.floor(bottom / cellSize);
    const neighborIndexes = new Set<number>();
    for (let x = leftCell - 1; x <= rightCell + 1; x += 1) {
      for (let y = topCell - 1; y <= bottomCell + 1; y += 1) {
        for (const index of cells.get(`${x}:${y}`) ?? []) neighborIndexes.add(index);
      }
    }
    if ([...neighborIndexes].some((index) => {
      const other = accepted[index];
      return other && left < other.right && right > other.left && top < other.bottom && bottom > other.top;
    })) continue;
    const index = accepted.push({ localKey: item.parcel.local_key, text: item.text, x: item.anchor.x, y: item.anchor.y, fontSize: item.fontSize, left, right, top, bottom }) - 1;
    for (let x = leftCell; x <= rightCell; x += 1) {
      for (let y = topCell; y <= bottomCell; y += 1) {
        const cellKey = `${x}:${y}`;
        const bucket = cells.get(cellKey) ?? [];
        bucket.push(index);
        cells.set(cellKey, bucket);
      }
    }
  }
  return accepted.map(({ localKey, text, x, y, fontSize }) => ({ localKey, text, x, y, fontSize }));
}

/**
 * Return one consistent on-screen label size when the full label fits inside
 * its lot. Narrow lots wait until closer zoom instead of shrinking to unreadable
 * sizes. Width uses a conservative average glyph-width estimate for the map's
 * inherited system sans font.
 */
export function fitStandardMapLabelFontSize(
  bounds: { width: number; height: number },
  label: string,
  screenPixelsPerMapUnit: number,
  targetScreenPixels = STANDARD_MAP_LABEL_SCREEN_PX,
): number | null {
  if (
    !Number.isFinite(bounds.width) || bounds.width <= 0
    || !Number.isFinite(bounds.height) || bounds.height <= 0
    || !Number.isFinite(screenPixelsPerMapUnit) || screenPixelsPerMapUnit <= 0
    || !Number.isFinite(targetScreenPixels) || targetScreenPixels <= 0
  ) return null;

  const targetMapUnits = targetScreenPixels / screenPixelsPerMapUnit;
  const widthFit = bounds.width / (Math.max(label.length, 1) * 0.62);
  const heightFit = bounds.height * 0.5;
  return Math.min(widthFit, heightFit) >= targetMapUnits ? targetMapUnits : null;
}

/** A stable local display reference, never an official lot identity. */
export function demoPlotLabel(parcel: HopkinsDemoLabelParcel): string {
  const sourceReference = parcel.local_preview?.parentDetectionId ?? parcel.lot_number;
  const sourceNumber = /^L-(\d+)$/i.exec(sourceReference)?.[1] ?? String(parcel.local_key).padStart(3, "0");
  const childSuffix = parcel.local_preview ? `-${String(parcel.local_preview.childNumber).padStart(2, "0")}` : "";
  return `Demo Plot ${sourceNumber}${childSuffix}`;
}

/** Compact only for map ink; the search and detail panel retain the full label. */
export function demoMapPlotLabel(parcel: HopkinsDemoLabelParcel): string {
  return demoPlotLabel(parcel).replace(/^Demo Plot /, "D-");
}
