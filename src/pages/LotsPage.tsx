import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BulkIngestPanel } from "../components/admin/parcels/BulkIngestPanel";
import { ParcelDrawer } from "../components/admin/parcels/ParcelDrawer";
import type { CanvasParcel } from "../components/admin/parcels/ParcelMapCanvas";
import { TierCatalogManager } from "../components/admin/parcels/TierCatalogManager";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { Badge } from "../components/ui/Badge";
import { statusBadgeTone } from "../lib/statusBadgeTone";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { Field, Select } from "../components/ui/Field";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import { isAvailableForSalesSelection, isExistingInventoryRecord, isRasterDetection } from "../../supabase/functions/_shared/parcel-provenance.mjs";
import type { LotReservation, Parcel, ParcelStatus } from "../types/database";

type LotsTab = "board" | "ingest" | "tiers";
type StatusFilter = "all" | ParcelStatus;

export function LotsPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const scopeKey = workspace ? `${workspace.tenantId}:${workspace.projectId}:${workspace.phaseId}:${workspace.mapExperienceMode}` : "unselected";
  const [tab, setTab] = useState<LotsTab>("board");
  const [selectedParcelId, setSelectedParcelId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["lot-board", scopeKey],
    queryFn: async () => {
      const { data: lots, error: queryError } = await supabase.from("parcel_board_view").select("*")
        .eq("tenant_id", workspace!.tenantId).eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId)
        .order("lot_number");
      if (queryError) throw queryError;
      return lots;
    },
    enabled: Boolean(workspace),
  });
  const { data: reservations } = useQuery({
    queryKey: ["lot-board-active-reservations", scopeKey, (data ?? []).map((lot) => lot.id).join(",")],
    queryFn: async () => {
      const parcelIds = (data ?? []).map((lot) => lot.id);
      if (!parcelIds.length) return [] as LotReservation[];
      const { data: rows, error: queryError } = await supabase
        .from("lot_reservations")
        .select("*")
        .eq("tenant_id", workspace!.tenantId)
        .in("parcel_id", parcelIds)
        .in("status", ["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
      if (queryError) throw queryError;
      return rows as LotReservation[];
    },
    enabled: Boolean(workspace && data),
  });
  const { data: pendingVoidResolutions } = useQuery({
    queryKey: ["lot-board-void-resolutions", scopeKey, (data ?? []).map((lot) => lot.id).join(",")],
    queryFn: async () => {
      const parcelIds = (data ?? []).map((lot) => lot.id);
      if (!parcelIds.length) return [] as Array<{ parcel_id: number }>;
      const { data: rows, error: queryError } = await supabase
        .from("contract_void_resolutions")
        .select("parcel_id")
        .eq("tenant_id", workspace!.tenantId)
        .in("parcel_id", parcelIds)
        .eq("status", "pending");
      if (queryError) throw queryError;
      return rows as Array<{ parcel_id: number }>;
    },
    enabled: Boolean(workspace && data),
  });
  const activeReservationByParcel = new Map((reservations ?? []).filter((reservation) => reservation.parcel_id).map((reservation) => [reservation.parcel_id, reservation]));
  const pendingResolutionParcelIds = new Set((pendingVoidResolutions ?? []).map((resolution) => resolution.parcel_id));
  const { data: tenantContext } = useQuery({
    queryKey: ["lot-board-tenant", scopeKey],
    queryFn: async () => {
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .select("masterplan_image_url")
        .eq("id", workspace!.tenantId)
        .maybeSingle();
      if (orgError) throw orgError;
      return { tenantId: workspace!.tenantId, masterplanImageUrl: (org as { masterplan_image_url: string | null } | null)?.masterplan_image_url ?? null };
    },
    enabled: Boolean(workspace),
  });
  const { data: mapOutlineCount = 0, isLoading: mapOutlineLoading, error: mapOutlineError } = useQuery({
    queryKey: ["lot-board-map-snapshot", scopeKey],
    queryFn: async () => {
      const { data: snapshot, error: snapshotError } = await supabase.from("map_feature_snapshots").select("outline_count")
        .eq("tenant_id", workspace!.tenantId).eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId)
        .eq("is_active", true).maybeSingle();
      if (snapshotError) throw snapshotError;
      return snapshot?.outline_count ?? 0;
    },
    enabled: Boolean(workspace),
  });
  const canvasParcels: CanvasParcel[] = (data ?? []).map((lot) => ({
    id: lot.id,
    lot_number: lot.lot_number,
    status: lot.status,
    base_price: Number(lot.base_price ?? 0),
    dimensions: lot.dimensions ?? null,
    map_polygon: Array.isArray(lot.map_polygon) ? lot.map_polygon : null,
    tier_key: lot.tier_key ?? null,
    tier_label: lot.tier_label ?? null,
    needs_review: lot.needs_review === true,
  }));
  const selectedParcel = (data ?? []).find((lot) => lot.id === selectedParcelId) ?? null;

  const tierOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const lot of data ?? []) {
      if (lot.tier_key) byKey.set(lot.tier_key, lot.tier_label ?? lot.tier_key);
    }
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const existingInventory = useMemo(() => (data ?? []).filter(isExistingInventoryRecord), [data]);
  const rasterDetections = useMemo(() => (data ?? []).filter(isRasterDetection), [data]);
  const otherProvenance = useMemo(() => (data ?? []).filter((lot) => !isExistingInventoryRecord(lot) && !isRasterDetection(lot)), [data]);
  const availableInventoryCount = useMemo(() => existingInventory.filter(isAvailableForSalesSelection).length, [existingInventory]);
  const detectionReviewCount = useMemo(() => rasterDetections.filter((lot) => lot.needs_review === true).length, [rasterDetections]);
  const detectionReviewClearCount = useMemo(() => rasterDetections.filter((lot) => lot.needs_review === false).length, [rasterDetections]);
  const reviewCount = useMemo(() => (data ?? []).filter((lot) => lot.needs_review === true).length, [data]);

  const filteredLots = useMemo(
    () =>
      (data ?? []).filter(
        (lot) =>
          (statusFilter === "all" || lot.status === statusFilter) &&
          (tierFilter === "all" || lot.tier_key === tierFilter) &&
          (!reviewOnly || lot.needs_review === true),
      ),
    [data, statusFilter, tierFilter, reviewOnly],
  );
  const filteredInventory = useMemo(() => filteredLots.filter(isExistingInventoryRecord), [filteredLots]);
  const filteredDetections = useMemo(() => filteredLots.filter(isRasterDetection), [filteredLots]);
  const filteredOther = useMemo(() => filteredLots.filter((lot) => !isExistingInventoryRecord(lot) && !isRasterDetection(lot)), [filteredLots]);

  function openDrawer(parcelId: number) {
    setSelectedParcelId(parcelId);
    setDrawerOpen(true);
  }

  if (!workspace) {
    return workspaceLoading ? <LoadingState label="Loading selected project map" /> : (
      <ErrorState message={workspaceError ?? "No accessible tenant, project, and phase are selected. Choose a permitted workspace above to view the map."} />
    );
  }

  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Land Inventory</p>
        <h1 className="v2-page-title">Lots</h1>
        <p className="v2-page-description">{workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}. Existing inventory records and raster map detections are shown separately; display outlines are counted on their own.</p>
        <NavLink
          to="/lots/correct"
          className="mt-3 inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold text-primary hover:bg-primary-soft"
        >
          Edit in correction workspace
        </NavLink>
      </div>
      <div className="flex gap-2" role="tablist" aria-label="Lots sections">
        {(["board", "ingest", "tiers"] as LotsTab[]).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-semibold transition",
              tab === value ? "bg-primary-soft text-primary" : "text-muted-foreground hover:text-primary",
            )}
          >
            {value === "board" ? "Inventory Board" : value === "ingest" ? "Bulk Ingest" : "Tier Catalogue"}
          </button>
        ))}
      </div>
      {tab === "ingest" ? (
        <BulkIngestPanel
          boardRows={(data ?? []).map((lot) => ({ lot_number: lot.lot_number, base_price: lot.base_price ?? null, map_polygon: lot.map_polygon }))}
        />
      ) : null}
      {tab === "tiers" ? <TierCatalogManager tenantId={workspace.tenantId} /> : null}
      {tab === "board" ? (
        <>
          {isLoading ? <LoadingState /> : null}
          {error ? <ErrorState message={(error as Error).message} /> : null}
          {mapOutlineLoading ? <LoadingState label="Loading map geometry" /> : null}
          {mapOutlineError ? <ErrorState message={(mapOutlineError as Error).message} /> : null}
          {!mapOutlineLoading && !mapOutlineError && mapOutlineCount > 0 ? (
            <div className="v2-workflow-panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold text-primary">{mapOutlineCount} mapped outlines</p>
                <p className="mt-1 text-sm text-muted-foreground">Published map geometry, separate from parcel inventory records.</p>
              </div>
              <NavLink
                to={`/embed/${encodeURIComponent(workspace.tenantSlug)}/${encodeURIComponent(workspace.projectSlug)}?phase=${encodeURIComponent(workspace.phaseSlug)}`}
                target="_blank"
                rel="noreferrer"
                className="focus-ring inline-flex min-h-10 items-center justify-center rounded-md border border-primary/20 px-3 text-sm font-semibold text-primary hover:bg-primary-soft"
              >
                Open map preview
              </NavLink>
            </div>
          ) : null}
          {!isLoading && data?.length === 0 ? <EmptyState title="No parcel inventory records" detail={mapOutlineCount > 0 ? `This workspace has ${mapOutlineCount} published map outlines and no parcel inventory records.` : "No parcel records are assigned to the selected tenant, project, and phase."} /> : null}
          <div className="v2-workflow-panel p-4 text-sm text-primary">
            Status and price are stored parcel values. Raster detections remain map/review data and are excluded from sales selectors.
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <InventoryMetric label="Existing inventory records" value={existingInventory.length} tone="blue" />
            <InventoryMetric label="Available for selection" value={availableInventoryCount} tone="green" />
            <InventoryMetric label="Raster detections" value={rasterDetections.length} tone="slate" />
            <InventoryMetric label="Raster detections needing review" value={detectionReviewCount} tone="amber" />
            <InventoryMetric label="Active holds" value={reservations?.length ?? 0} tone="blue" />
          </div>
          <div className="v2-workflow-panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Stored status filter">
              <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">All statuses</option>
                <option value="Available">Available</option>
                <option value="Reserved">Reserved</option>
                <option value="Sold">Sold</option>
              </Select>
            </Field>
            <Field label="Tier filter">
              <Select value={tierFilter} onChange={(event) => setTierFilter(event.target.value)}>
                <option value="all">All tiers</option>
                {tierOptions.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />
              Needs review only{reviewCount ? ` (${reviewCount})` : ""}
            </label>
            <p className="self-end pb-2 text-sm text-muted-foreground">
              Showing {filteredInventory.length} of {existingInventory.length} existing inventory records, {filteredDetections.length} of {rasterDetections.length} raster detections, and {filteredOther.length} of {otherProvenance.length} other records.
            </p>
          </div>
          <div className="space-y-4">
            {[
              { key: "inventory", title: "Existing manual inventory", total: existingInventory.length, records: filteredInventory, note: "Existing records and their stored values. The label does not mean these were newly verified." },
              { key: "detections", title: "Raster map detections", total: rasterDetections.length, records: filteredDetections, note: `${detectionReviewCount} marked as needing review · ${detectionReviewClearCount} with the review flag clear. All remain available in this map/review list.` },
              { key: "other", title: "Other provenance records", total: otherProvenance.length, records: filteredOther, note: "These records are excluded from sales selection until their provenance is classified." },
            ].filter((group) => group.total > 0).map((group) => (
              <section key={group.key} className="v2-workflow-panel p-4" aria-label={`${group.title}, ${group.total} records`}>
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                  <h2 className="font-semibold text-primary">{group.title} <span className="font-normal text-muted-foreground">({group.total})</span></h2>
                  <p className="text-xs text-muted-foreground">{group.note}</p>
                </div>
                {group.records.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No records match the current filters.</p> : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {group.records.map((lot) => {
                const inventoryRecord = isExistingInventoryRecord(lot);
                const rasterDetection = isRasterDetection(lot);
                const availableForSelection = isAvailableForSalesSelection(lot);
                const activeReservation = activeReservationByParcel.get(lot.id);
                const resolutionRequired = pendingResolutionParcelIds.has(lot.id);
                return (
                  <button
                    key={lot.id}
                    type="button"
                    onClick={() => openDrawer(lot.id)}
                    className={cn(
                      "aspect-[1.35] rounded-md border p-3 text-left text-sm transition hover:-translate-y-px hover:shadow-[var(--shadow-button)]",
                      availableForSelection && "border-success/25 bg-success/10",
                      inventoryRecord && lot.status === "Reserved" && "border-warning/25 bg-accent-soft",
                      inventoryRecord && lot.status === "Sold" && "border-slate/20 bg-slate/10",
                      !inventoryRecord && "border-border bg-muted/35",
                      activeReservation && "ring-2 ring-info/20",
                    )}
                  >
                    <div className="flex h-full flex-col justify-between gap-2">
                      <strong className="text-foreground">{rasterDetection ? `Map detection ${lot.lot_number}` : `Lot ${lot.lot_number}`}</strong>
                      <span className="text-xs text-muted-foreground">{lot.dimensions}</span>
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={inventoryRecord ? statusBadgeTone(lot.status) : "gray"}>{rasterDetection ? `Stored status: ${lot.status}` : lot.status}</Badge>
                        {rasterDetection ? <Badge tone="gray">Raster detection · not sales inventory</Badge> : null}
                        {!inventoryRecord && !rasterDetection ? <Badge tone="gray">Unclassified provenance</Badge> : null}
                        {lot.tier_label ? <Badge tone="gray">{lot.tier_label}</Badge> : null}
                        {rasterDetection && lot.needs_review === true ? <Badge tone="red">Needs review</Badge> : null}
                        {rasterDetection && lot.needs_review === false ? <Badge tone="gray">Review flag clear</Badge> : null}
                        {activeReservation ? <Badge tone="blue">Active Reservation</Badge> : null}
                        {resolutionRequired ? <Badge tone="red">Resolution Required</Badge> : null}
                      </span>
                    </div>
                  </button>
                );
              })}
                </div>
                )}
              </section>
            ))}
          </div>
        </>
      ) : null}
      <ParcelDrawer
        parcel={selectedParcel as Parcel | null}
        parcels={canvasParcels}
        tenantId={selectedParcel?.tenant_id ?? tenantContext?.tenantId ?? null}
        projectId={workspace.projectId}
        phaseId={workspace.phaseId}
        masterplanImageUrl={tenantContext?.masterplanImageUrl ?? null}
        open={drawerOpen && selectedParcel !== null}
        onClose={() => setDrawerOpen(false)}
      />
    </section>
  );
}

function InventoryMetric({ label, value, tone }: { label: string; value: number; tone: "green" | "amber" | "slate" | "blue" }) {
  return (
    <div className="v2-record-row">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-primary">{label}</p>
        <Badge tone={tone}>{value}</Badge>
      </div>
    </div>
  );
}
