export interface SyntheticReviewCase {
  id: string;
  detection_id: string;
  polygon_pct: Array<{ x: number; y: number }>;
  crop_box_px: [number, number, number, number];
  crop_file: null;
  crop_sha256: null;
}

export interface SyntheticReviewManifest {
  schema_version: 1;
  benchmark_id: string;
  source_image: {
    name: string;
    sha256: string;
    width: number;
    height: number;
    coordinate_space: string;
  };
  lot_geometry_sha256: string;
  review_key: string;
  cases: SyntheticReviewCase[];
}

export function createSyntheticReviewManifest(sourceBytes: Uint8Array, lotsBytes: Uint8Array): SyntheticReviewManifest;
