import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BulkIngestPanel } from "../components/admin/parcels/BulkIngestPanel";
import { ParcelDrawer } from "../components/admin/parcels/ParcelDrawer";
import type { CanvasParcel } from "../components/admin/parcels/ParcelMapCanvas";
import { TierCatalogManager } from "../components/admin/parcels/TierCatalogManager";
import { Badge } from "../components/ui/Badge";
import { statusBadgeTone } from "../lib/statusBadgeTone";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { Field, Select } from "../components/ui/Field";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import type { LotReservation, Parcel, ParcelStatus } from "../types/database";

type LotsTab = "board" | "ingest" | "tiers";
type StatusFilter = "all" | ParcelStatus;

export function LotsPage() {
  const [tab, setTab] = useState<LotsTab>("board");
  const [selectedParcelId, setSelectedParcelId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["lot-board"],
    queryFn: async () => {
      const { data: lots, error: queryError } = await supabase.from("parcel_board_view").select("*").order("lot_number");
      if (queryError) throw queryError;
      return lots;
    },
  });
  const { data: reservations } = useQuery({
    queryKey: ["lot-board-active-reservations"],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("lot_reservations")
        .select("*")
        .in("status", ["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
      if (queryError) throw queryError;
      return rows as LotReservation[];
    },
  });
  const { data: pendingVoidResolutions } = useQuery({
    queryKey: ["lot-board-void-resolutions"],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("contract_void_resolutions")
        .select("parcel_id")
        .eq("status", "pending");
      if (queryError) throw queryError;
      return rows as Array<{ parcel_id: number }>;
    },
  });
  const activeReservationByParcel = new Map((reservations ?? []).filter((reservation) => reservation.parcel_id).map((reservation) => [reservation.parcel_id, reservation]));
  const pendingResolutionParcelIds = new Set((pendingVoidResolutions ?? []).map((resolution) => resolution.parcel_id));
  const { data: tenantContext } = useQuery({
    queryKey: ["lot-board-tenant"],
    queryFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) return { tenantId: null as string | null, masterplanImageUrl: null as string | null };
      const { data: profile, error: profileError } = await supabase
        .from("admin_profiles")
        .select("tenant_id")
        .eq("user_id", sessionData.session.user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      const tenantId = (profile as { tenant_id: string | null } | null)?.tenant_id;
      if (!tenantId) return { tenantId: null, masterplanImageUrl: null };
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .select("masterplan_image_url")
        .eq("id", tenantId)
        .maybeSingle();
      if (orgError) throw orgError;
      return { tenantId, masterplanImageUrl: (org as { masterplan_image_url: string | null } | null)?.masterplan_image_url ?? null };
    },
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

  function openDrawer(parcelId: number) {
    setSelectedParcelId(parcelId);
    setDrawerOpen(true);
  }

  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Land Inventory</p>
        <h1 className="v2-page-title">Lots</h1>
        <p className="v2-page-description">Phase 1 inventory board with current availability and reservation status.</p>
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
      {tab === "tiers" ? <TierCatalogManager tenantId={tenantContext?.tenantId ?? null} /> : null}
      {tab === "board" ? (
        <>
          {isLoading ? <LoadingState /> : null}
          {error ? <ErrorState message={(error as Error).message} /> : null}
          {!isLoading && data?.length === 0 ? <EmptyState title="No lots found" detail="Run the Supabase migration to seed the 24 Phase 1 lots." /> : null}
          <div className="v2-workflow-panel p-4 text-sm text-primary">
            Active Reservation means there is an internal buyer-interest hold for this lot. This does not automatically change the lot&apos;s core status.
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <InventoryMetric label="Available" value={data?.filter((lot) => lot.status === "Available").length ?? 0} tone="green" />
            <InventoryMetric label="Reserved" value={data?.filter((lot) => lot.status === "Reserved").length ?? 0} tone="amber" />
            <InventoryMetric label="Sold" value={data?.filter((lot) => lot.status === "Sold").length ?? 0} tone="slate" />
            <InventoryMetric label="Active holds" value={reservations?.length ?? 0} tone="blue" />
          </div>
          <div className="v2-workflow-panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Status filter">
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
              Showing {filteredLots.length} of {data?.length ?? 0} lots.
            </p>
          </div>
          <div className="v2-workflow-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>Access road</span>
              <span>5-acre subdivision layout</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {filteredLots.map((lot) => {
                const activeReservation = activeReservationByParcel.get(lot.id);
                const resolutionRequired = pendingResolutionParcelIds.has(lot.id);
                return (
                  <button
                    key={lot.id}
                    type="button"
                    onClick={() => openDrawer(lot.id)}
                    className={cn(
                      "aspect-[1.35] rounded-md border p-3 text-left text-sm shadow-sm transition hover:-translate-y-px hover:shadow-[var(--shadow-button)]",
                      lot.status === "Available" && "border-success/25 bg-success/10",
                      lot.status === "Reserved" && "border-warning/25 bg-accent-soft",
                      lot.status === "Sold" && "border-slate/20 bg-slate/10",
                      activeReservation && "ring-2 ring-info/20",
                    )}
                  >
                    <div className="flex h-full flex-col justify-between gap-2">
                      <strong className="text-foreground">Lot {lot.lot_number}</strong>
                      <span className="text-xs text-muted-foreground">{lot.dimensions}</span>
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={statusBadgeTone(lot.status)}>{lot.status}</Badge>
                        {lot.tier_label ? <Badge tone="gray">{lot.tier_label}</Badge> : null}
                        {lot.needs_review === true ? <Badge tone="red">Needs Review</Badge> : null}
                        {activeReservation ? <Badge tone="blue">Active Reservation</Badge> : null}
                        {resolutionRequired ? <Badge tone="red">Resolution Required</Badge> : null}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
      <ParcelDrawer
        parcel={selectedParcel as Parcel | null}
        parcels={canvasParcels}
        tenantId={selectedParcel?.tenant_id ?? tenantContext?.tenantId ?? null}
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
