import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { pointsToSvgPoints, sanitizePolygon, type MapPoint } from "../../../hooks/useParcelMap";
import type { ParcelStatus } from "../../../types/database";
import { Button } from "../../ui/Button";
import { ErrorState } from "../../ui/State";

export interface PreviewPolygon {
  id: number | string;
  lot_number: string;
  status: ParcelStatus;
  map_polygon: MapPoint[] | null;
}

interface MasterplanPreviewModalProps {
  open: boolean;
  tenantId: string | null;
  /** Candidate image to verify. */
  draftImageUrl: string | null;
  draftLabel: string;
  /** Existing version row to activate, if the draft is already stored. */
  draftVersionId?: string | null;
  /** New upload not yet stored; created on publish. */
  draftUpload?: { fileName: string } | null;
  canManage: boolean;
  onClose: () => void;
  onPublished?: (imageUrl: string) => void;
}

const STATUS_FILL: Record<ParcelStatus, string> = {
  Available: "#22c55e",
  Reserved: "#f59e0b",
  Sold: "#ef4444",
};

export function MasterplanPreviewModal({
  open,
  tenantId,
  draftImageUrl,
  draftLabel,
  draftVersionId = null,
  draftUpload = null,
  canManage,
  onClose,
  onPublished,
}: MasterplanPreviewModalProps) {
  const [activeImageUrl, setActiveImageUrl] = useState<string | null>(null);
  const [polygons, setPolygons] = useState<PreviewPolygon[]>([]);
  const [opacity, setOpacity] = useState(100);
  const [showBaseline, setShowBaseline] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !tenantId) return;
    let cancelled = false;
    async function loadContext() {
      const [{ data: org }, { data: parcels, error: parcelsError }] = await Promise.all([
        supabase.from("organizations").select("masterplan_image_url").eq("id", tenantId).maybeSingle(),
        supabase.from("parcels").select("id, lot_number, status, map_polygon").eq("tenant_id", tenantId).order("lot_number"),
      ]);
      if (cancelled) return;
      if (parcelsError) {
        setError(parcelsError.message);
        return;
      }
      setActiveImageUrl((org as { masterplan_image_url: string | null } | null)?.masterplan_image_url ?? null);
      setPolygons(
        ((parcels ?? []) as Array<{ id: number; lot_number: string; status: ParcelStatus; map_polygon: unknown }>).map((row) => ({
          id: row.id,
          lot_number: row.lot_number,
          status: row.status,
          map_polygon: sanitizePolygon(row.map_polygon as MapPoint[] | null),
        })),
      );
    }
    setError(null);
    setShowBaseline(false);
    void loadContext();
    return () => {
      cancelled = true;
    };
  }, [open, tenantId]);

  if (!open) return null;

  const backgroundUrl = showBaseline ? activeImageUrl : draftImageUrl;
  const alignedCount = polygons.filter((p) => (p.map_polygon ?? []).length >= 3).length;

  async function handlePublish() {
    if (!tenantId || !canManage || (!draftVersionId && !draftUpload)) return;
    setError(null);
    setPublishing(true);
    try {
      if (draftVersionId) {
        const { error: updateError } = await supabase
          .from("masterplan_versions")
          .update({ is_active: true })
          .eq("id", draftVersionId)
          .eq("tenant_id", tenantId);
        if (updateError) throw new Error(updateError.message);
      } else {
        const { error: insertError } = await supabase.from("masterplan_versions").insert({
          tenant_id: tenantId,
          image_url: draftImageUrl,
          file_name: draftUpload?.fileName ?? "masterplan",
          is_active: true,
        });
        if (insertError) throw new Error(insertError.message);
      }
      // Activation trigger syncs organizations + business_settings.
      if (draftImageUrl) onPublished?.(draftImageUrl);
      onClose();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Masterplan alignment preview">
      <button type="button" aria-label="Close preview" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div className="relative grid max-h-[90vh] w-full max-w-4xl gap-3 overflow-y-auto rounded-lg bg-background p-4 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Alignment preview</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-primary">{draftLabel}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {alignedCount} of {polygons.length} lots have boundaries overlaid. Verify alignment before publishing.
            </p>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {error ? <ErrorState message={error} /> : null}

        <div className="relative overflow-hidden rounded-md border border-border bg-muted">
          {backgroundUrl ? (
            <img
              src={backgroundUrl}
              alt={showBaseline ? "Current active masterplan" : "Draft masterplan candidate"}
              className="block w-full select-none"
              style={{ opacity: opacity / 100 }}
              draggable={false}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {showBaseline ? "No active masterplan yet." : "No draft image to preview."}
            </p>
          )}
          {backgroundUrl ? (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
              {polygons.map((parcel) => {
                const points = parcel.map_polygon ?? [];
                if (points.length < 3) return null;
                return (
                  <polygon
                    key={parcel.id}
                    points={pointsToSvgPoints(points)}
                    fill={STATUS_FILL[parcel.status] ?? "#22c55e"}
                    fillOpacity={0.35}
                    stroke="#ffffff"
                    strokeWidth={0.4}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`Lot ${parcel.lot_number} — ${parcel.status}`}</title>
                  </polygon>
                );
              })}
            </svg>
          ) : null}
          <span className="absolute left-3 top-3 rounded-full bg-card/90 px-2 py-1 text-xs font-semibold">
            {showBaseline ? "Baseline: current active" : "Draft candidate"}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <label className="grid gap-1 text-sm font-medium text-foreground">
            Draft image opacity: {opacity}%
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={opacity}
              onChange={(event) => setOpacity(Number(event.target.value))}
              className="w-full"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={showBaseline} onChange={(event) => setShowBaseline(event.target.checked)} disabled={!activeImageUrl} />
            Compare with current active
          </label>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Keep Draft
          </Button>
          <Button type="button" disabled={!canManage || publishing || !draftImageUrl} onClick={() => void handlePublish()}>
            {publishing ? "Publishing…" : "Publish & Activate Version"}
          </Button>
        </div>
      </div>
    </div>
  );
}
