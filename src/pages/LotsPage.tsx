import { useQuery } from "@tanstack/react-query";
import { Badge, statusBadgeTone } from "../components/ui/Badge";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import type { LotReservation } from "../types/database";

export function LotsPage() {
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
  const activeReservationByParcel = new Map((reservations ?? []).filter((reservation) => reservation.parcel_id).map((reservation) => [reservation.parcel_id, reservation]));

  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Land Inventory</p>
        <h1 className="v2-page-title">Lots</h1>
        <p className="v2-page-description">Phase 1 inventory board with current availability and reservation status.</p>
      </div>
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {!isLoading && data?.length === 0 ? <EmptyState title="No lots found" detail="Run the Supabase migration to seed the 24 Phase 1 lots." /> : null}
      <div className="v2-workflow-panel p-4 text-sm text-primary">
        Active Reservation means there is an internal buyer-interest hold for this lot. This does not automatically change the lot's core status.
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InventoryMetric label="Available" value={data?.filter((lot) => lot.status === "Available").length ?? 0} tone="green" />
        <InventoryMetric label="Reserved" value={data?.filter((lot) => lot.status === "Reserved").length ?? 0} tone="amber" />
        <InventoryMetric label="Sold" value={data?.filter((lot) => lot.status === "Sold").length ?? 0} tone="slate" />
        <InventoryMetric label="Active holds" value={reservations?.length ?? 0} tone="blue" />
      </div>
      <div className="v2-workflow-panel p-4">
        <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>Access road</span>
          <span>5-acre subdivision layout</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {data?.map((lot) => {
            const activeReservation = activeReservationByParcel.get(lot.id);
            return (
              <div
                key={lot.id}
                className={cn(
                  "aspect-[1.35] rounded-md border p-3 text-sm shadow-sm transition hover:-translate-y-px hover:shadow-[var(--shadow-button)]",
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
                    {activeReservation ? <Badge tone="blue">Active Reservation</Badge> : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
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
