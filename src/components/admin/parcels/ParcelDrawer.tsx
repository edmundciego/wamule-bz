import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../../lib/utils";
import { supabase } from "../../../lib/supabase";
import { sanitizePolygon, useParcelMap, type MapPoint } from "../../../hooks/useParcelMap";
import type { Parcel, ParcelStatus } from "../../../types/database";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { ErrorState } from "../../ui/State";
import { ParcelMapCanvas, type CanvasParcel } from "./ParcelMapCanvas";

interface ParcelDrawerProps {
  parcel: Parcel | null;
  parcels: CanvasParcel[];
  tenantId?: string | null;
  /** Aerial/site-map photo URL. Falls back to community-fee masterplan or site map when wired. */
  masterplanImageUrl?: string | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (parcelId: number) => void;
}

type DrawerTab = "details" | "boundary";

const STATUS_OPTIONS: ParcelStatus[] = ["Available", "Reserved", "Sold"];

export function ParcelDrawer({
  parcel,
  parcels,
  tenantId = null,
  masterplanImageUrl = null,
  open,
  onClose,
  onSaved,
}: ParcelDrawerProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DrawerTab>("details");
  const [status, setStatus] = useState<ParcelStatus>("Available");
  const [basePrice, setBasePrice] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailSaving, setDetailSaving] = useState(false);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [boundarySaving, setBoundarySaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const map = useParcelMap({ initialPoints: parcel?.map_polygon ?? [], initialMode: "view" });

  useEffect(() => {
    if (!open) return;
    setTab("details");
    setDetailError(null);
    setBoundaryError(null);
    setSavedMessage(null);
    setStatus(parcel?.status ?? "Available");
    setBasePrice(parcel ? String(parcel.base_price ?? "") : "");
    setDimensions(parcel?.dimensions ?? "");
    map.loadPolygon(parcel?.map_polygon ?? []);
    map.setMode("view");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parcel?.id]);

  const activeParcel = parcel;
  if (!open || !activeParcel) return null;

  async function handleDetailsSave() {
    if (!activeParcel) return;
    setDetailError(null);
    setSavedMessage(null);
    const price = Number(basePrice);
    if (!Number.isFinite(price) || price < 0) {
      setDetailError("Enter a valid non-negative price.");
      return;
    }
    setDetailSaving(true);
    const { error } = await supabase
      .from("parcels")
      .update({
        status,
        base_price: price,
        dimensions: dimensions.trim() || activeParcel.dimensions,
      })
      .eq("id", activeParcel.id);
    setDetailSaving(false);
    if (error) {
      setDetailError(error.message);
      return;
    }
    setSavedMessage("Lot details saved.");
    await queryClient.invalidateQueries({ queryKey: ["lot-board"] });
    onSaved?.(activeParcel.id);
  }

  async function handleBoundarySave() {
    if (!activeParcel) return;
    setBoundaryError(null);
    setSavedMessage(null);
    if (map.points.length < 3) {
      setBoundaryError("Draw at least 3 vertices before saving.");
      return;
    }
    setBoundarySaving(true);
    // supabase-js serializes the JS array to jsonb; SQL equivalent is
    // jsonb_build_array(...) / to_jsonb(...). RLS tenant isolation applies;
    // tenantId is sent explicitly when the caller provides it.
    const payload: { map_polygon: MapPoint[]; tenant_id?: string } = {
      map_polygon: sanitizePolygon(map.points),
    };
    if (tenantId) payload.tenant_id = tenantId;
    let query = supabase.from("parcels").update(payload).eq("id", activeParcel.id);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { error } = await query;
    setBoundarySaving(false);
    if (error) {
      setBoundaryError(error.message);
      return;
    }
    setSavedMessage(`Boundary saved (${map.points.length} vertices).`);
    await queryClient.invalidateQueries({ queryKey: ["lot-board"] });
    onSaved?.(activeParcel.id);
  }

  async function handleClearBoundary() {
    if (!activeParcel) return;
    setBoundaryError(null);
    setSavedMessage(null);
    map.clearPolygon();
    setBoundarySaving(true);
    let query = supabase.from("parcels").update({ map_polygon: [] }).eq("id", activeParcel.id);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { error } = await query;
    setBoundarySaving(false);
    if (error) {
      setBoundaryError(error.message);
      return;
    }
    setSavedMessage("Boundary cleared.");
    await queryClient.invalidateQueries({ queryKey: ["lot-board"] });
    onSaved?.(activeParcel.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Lot ${activeParcel.lot_number}`}>
      <button type="button" aria-label="Close parcel drawer" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Parcel admin</p>
            <h2 className="mt-1 font-display text-2xl font-semibold text-primary">Lot {activeParcel.lot_number}</h2>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex gap-2 border-b border-border px-4 pt-3" role="tablist" aria-label="Parcel sections">
          {(["details", "boundary"] as DrawerTab[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "rounded-t-md px-3 py-2 text-sm font-semibold transition",
                tab === value ? "bg-primary-soft text-primary" : "text-muted-foreground hover:text-primary",
              )}
            >
              {value === "details" ? "Details" : "Map Boundary"}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {savedMessage ? (
            <div className="crm-success-panel mb-3 p-3 text-sm" role="status">
              {savedMessage}
            </div>
          ) : null}

          {tab === "details" ? (
            <div className="grid gap-4">
              {detailError ? <ErrorState message={detailError} /> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Status">
                  <Select value={status} onChange={(event) => setStatus(event.target.value as ParcelStatus)}>
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Base price (BZD)">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={basePrice}
                    onChange={(event) => setBasePrice(event.target.value)}
                  />
                </Field>
              </div>
              <Field label="Dimensions">
                <Input value={dimensions} onChange={(event) => setDimensions(event.target.value)} placeholder="75 x 100 ft" />
              </Field>
              <div>
                <Button type="button" onClick={handleDetailsSave} disabled={detailSaving}>
                  {detailSaving ? "Saving…" : "Save details"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              {boundaryError ? <ErrorState message={boundaryError} /> : null}
              <ParcelMapCanvas
                imageUrl={masterplanImageUrl}
                parcels={parcels}
                activeParcelId={activeParcel.id}
                draftPolygon={map.points}
                mode={map.mode}
                snapEnabled={map.snapEnabled}
                selectedVertex={map.selectedVertex}
                saving={boundarySaving}
                onModeChange={map.setMode}
                onSnapChange={map.setSnapEnabled}
                onAddPoint={map.addPoint}
                onUpdatePoint={map.updatePoint}
                onRemovePoint={map.removePoint}
                onSelectVertex={map.setSelectedVertex}
                onSelectParcel={() => undefined}
                onClear={handleClearBoundary}
                onSave={handleBoundarySave}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Boundary is stored as responsive percentages on <code>public.parcels.map_polygon</code> for tenant{" "}
                {tenantId ?? "default"} and parcel {activeParcel.id} (SQL equivalent:{" "}
                <code>map_polygon = jsonb_build_array(...)</code>). Minimum 3 vertices.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
