import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";

export function LotsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["lot-board"],
    queryFn: async () => {
      const { data: lots, error: queryError } = await supabase.from("parcel_board_view").select("*").order("lot_number");
      if (queryError) throw queryError;
      return lots;
    },
  });

  return (
    <>
      <PageHeader title="Lots" description="Phase 1 site-style lot board for the first 24 lots." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {!isLoading && data?.length === 0 ? <EmptyState title="No lots found" detail="Run the Supabase migration to seed the 24 Phase 1 lots." /> : null}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="green">Available: {data?.filter((lot) => lot.status === "Available").length ?? 0}</Badge>
        <Badge tone="amber">Reserved: {data?.filter((lot) => lot.status === "Reserved").length ?? 0}</Badge>
        <Badge tone="red">Sold: {data?.filter((lot) => lot.status === "Sold").length ?? 0}</Badge>
      </div>
      <div className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>Access road</span>
          <span>5-acre subdivision layout</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {data?.map((lot) => (
            <div
              key={lot.id}
              className={cn(
                "aspect-[1.35] rounded-md border-2 p-3 text-sm shadow-sm",
                lot.status === "Available" && "border-emerald-600 bg-emerald-50",
                lot.status === "Reserved" && "border-amber-500 bg-amber-50",
                lot.status === "Sold" && "border-rose-700 bg-rose-50",
              )}
            >
              <div className="flex h-full flex-col justify-between">
                <strong>Lot {lot.lot_number}</strong>
                <span className="text-xs">{lot.dimensions}</span>
                <span>{lot.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
