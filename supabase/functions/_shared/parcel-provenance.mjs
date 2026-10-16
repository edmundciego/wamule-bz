const PROVENANCE = Object.freeze({
  INVENTORY: "existing_inventory",
  RASTER: "raster_detection",
  OTHER: "other",
});

export function classifyParcelProvenance(parcel) {
  const source = typeof parcel?.geometry_source === "string"
    ? parcel.geometry_source.trim().toLowerCase()
    : "";
  if (source === "manual") return PROVENANCE.INVENTORY;
  if (source === "raster-auto") return PROVENANCE.RASTER;
  return PROVENANCE.OTHER;
}

export function isExistingInventoryRecord(parcel) {
  return classifyParcelProvenance(parcel) === PROVENANCE.INVENTORY;
}

export function isRasterDetection(parcel) {
  return classifyParcelProvenance(parcel) === PROVENANCE.RASTER;
}

// Provenance is the gate. Status and review state refine an inventory record;
// price is deliberately ignored because detections may inherit a price.
export function isInventoryRecordReadyForReservation(parcel) {
  return isExistingInventoryRecord(parcel) && parcel?.needs_review === false;
}

export function isAvailableForSalesSelection(parcel) {
  return isInventoryRecordReadyForReservation(parcel) && parcel?.status === "Available";
}

export function isEligibleForPublicInquiry(parcel) {
  return isInventoryRecordReadyForReservation(parcel)
    && (parcel?.status === "Available" || parcel?.status === "Reserved");
}
