import { createHash } from "node:crypto";

const SOURCE_WIDTH = 5700;
const SOURCE_HEIGHT = 4800;
const sha256 = (input) => createHash("sha256").update(input).digest("hex");

/** Reproducibly bind the synthetic browser-review cases to their fixture bytes. */
export function createSyntheticReviewManifest(sourceBytes, lotsBytes) {
  const lots = JSON.parse(lotsBytes.toString("utf8"));
  return {
    schema_version: 1,
    benchmark_id: "wamule-map-renderer-synthetic-v1",
    source_image: {
      name: "masterplan_background.svg",
      sha256: sha256(sourceBytes),
      width: SOURCE_WIDTH,
      height: SOURCE_HEIGHT,
      coordinate_space: "synthetic source image pixels from polygon_pct × native dimensions",
    },
    lot_geometry_sha256: sha256(lotsBytes),
    review_key: "synthetic-renderer-portable-v1",
    cases: lots.map((lot, index) => {
      const xs = lot.polygon_pct.map((point) => point.x * SOURCE_WIDTH / 100);
      const ys = lot.polygon_pct.map((point) => point.y * SOURCE_HEIGHT / 100);
      const pad = 80;
      return {
        id: `SYN-${String(index + 1).padStart(3, "0")}`,
        detection_id: lot.id,
        polygon_pct: lot.polygon_pct,
        crop_box_px: [
          Math.max(0, Math.floor(Math.min(...xs) - pad)),
          Math.max(0, Math.floor(Math.min(...ys) - pad)),
          Math.min(SOURCE_WIDTH, Math.ceil(Math.max(...xs) + pad)),
          Math.min(SOURCE_HEIGHT, Math.ceil(Math.max(...ys) + pad)),
        ],
        // The editor derives a contextual crop in-browser from this exact
        // source image and polygon. It is not a separately fingerprinted file.
        crop_file: null,
        crop_sha256: null,
      };
    }),
  };
}
