export type ParcelProvenance = "existing_inventory" | "raster_detection" | "other";

export interface ParcelProvenanceFields {
  geometry_source?: string | null;
  status?: string | null;
  needs_review?: boolean | null;
  base_price?: number | null;
  price_override_cents?: number | null;
}

export function classifyParcelProvenance(parcel: ParcelProvenanceFields | null | undefined): ParcelProvenance;
export function isExistingInventoryRecord(parcel: ParcelProvenanceFields | null | undefined): boolean;
export function isRasterDetection(parcel: ParcelProvenanceFields | null | undefined): boolean;
export function isInventoryRecordReadyForReservation(parcel: ParcelProvenanceFields | null | undefined): boolean;
export function isAvailableForSalesSelection(parcel: ParcelProvenanceFields | null | undefined): boolean;
export function isEligibleForPublicInquiry(parcel: ParcelProvenanceFields | null | undefined): boolean;
