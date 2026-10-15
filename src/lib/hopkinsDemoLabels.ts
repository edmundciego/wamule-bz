export interface HopkinsDemoLabelParcel {
  lot_number: string;
  local_key: number;
  local_preview?: { parentDetectionId: string; childNumber: number };
}

export const STANDARD_MAP_LABEL_SCREEN_PX = 12;

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
