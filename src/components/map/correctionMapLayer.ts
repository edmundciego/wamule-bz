import type { MapCoordinate } from "../../lib/mapGeometry";

/** Review workflow state is deliberately separate from public sale status. */
export type CorrectionReviewStatus =
  | "unreviewed"
  | "reviewed"
  | "ambiguous"
  | "unreadable"
  | "skipped"
  | "geometry-issue"
  | "proposal-candidate"
  | "editable-draft"
  | "approved-preview";

/** Editor-owned overlay contract; contains no buyer, price, or inventory fields. */
export interface CorrectionMapLayer {
  title: string;
  imageUrl: string | null;
  parcels: Array<{ key: string; reference: string; polygon: MapCoordinate[] }>;
  selectedKey: string | null;
  reviewStatusByKey: Record<string, CorrectionReviewStatus>;
  geometryEdit?: { key: string; polygon: MapCoordinate[] } | null;
  /** A local-only trace gesture. Map clicks are converted back into source-relative percentages. */
  splitTrace?: {
    parentKey: string;
    parentPolygon: MapCoordinate[];
    completedChildren: MapCoordinate[][];
    activePoints: MapCoordinate[];
    drawingEnabled: boolean;
    activeIssue: string | null;
    editedChildIndex: number | null;
    editedChildPolygon: MapCoordinate[] | null;
    onMapPoint: (point: MapCoordinate) => void;
  } | null;
  onSelect: (key: string) => void;
  onGeometryDraftChange?: (key: string, polygon: MapCoordinate[]) => void;
}
