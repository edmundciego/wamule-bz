import type { MapCoordinate } from "../../lib/mapGeometry";

/** Review workflow state is deliberately separate from public sale status. */
export type CorrectionReviewStatus =
  | "unreviewed"
  | "reviewed"
  | "ambiguous"
  | "unreadable"
  | "skipped"
  | "geometry-issue";

/** Editor-owned overlay contract; contains no buyer, price, or inventory fields. */
export interface CorrectionMapLayer {
  title: string;
  imageUrl: string | null;
  parcels: Array<{ key: string; reference: string; polygon: MapCoordinate[] }>;
  selectedKey: string | null;
  reviewStatusByKey: Record<string, CorrectionReviewStatus>;
  geometryEdit?: { key: string; polygon: MapCoordinate[] } | null;
  onSelect: (key: string) => void;
  onGeometryDraftChange?: (key: string, polygon: MapCoordinate[]) => void;
}
