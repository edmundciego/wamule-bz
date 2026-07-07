import { useQuery } from "@tanstack/react-query";
import { ContractForm } from "../components/forms/ContractForm";
import { Badge } from "../components/ui/Badge";
import { Card, CardContent } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { money } from "../lib/utils";
import type { Contract, ContractStatus } from "../types/database";

type ContractListRow = Contract & {
  customers?: { first_name: string | null; last_name: string | null } | null;
  parcels?: { lot_number: string | null } | null;
  transactions?: Array<{ amount: number; transaction_type: string }> | null;
};

function contractStatusLabel(contract: Pick<Contract, "status" | "is_active">) {
  if (contract.status === "voided") return "Voided";
  if (contract.status === "cancelled") return "Cancelled";
  if (contract.status === "archived") return "Archived";
  return contract.is_active ? "Active" : "Closed";
}

function contractStatusTone(contract: Pick<Contract, "status" | "is_active">) {
  const tones: Record<ContractStatus, "green" | "gray" | "red"> = {
    active: "green",
    archived: "gray",
    cancelled: "gray",
    voided: "red",
  };
  return tones[contract.status] ?? (contract.is_active ? "green" : "gray");
}

export function ContractsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["contracts"],
    queryFn: async () => {
      const { data: contracts, error: queryError } = await supabase
        .from("contracts")
        .select("*, customers(first_name, last_name), parcels(lot_number), transactions(amount, transaction_type)")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return contracts as ContractListRow[];
    },
  });
  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Formal Records</p>
        <h1 className="v2-page-title">Contracts</h1>
        <p className="v2-page-description">Create purchase agreements and track active balances.</p>
      </div>
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <div className="grid content-start gap-3">
          {data?.map((contract) => {
            const paid =
              contract.transactions
                ?.filter((item: { transaction_type: string }) =>
                  ["Down Payment", "Land Installment"].includes(item.transaction_type),
                )
                .reduce((sum: number, item: { amount: number }) => sum + Number(item.amount), 0) ?? 0;
            const balance = Number(contract.final_purchase_price) - paid;
            const archived = ["voided", "cancelled", "archived"].includes(contract.status);
            return (
              <Card key={contract.id} className={archived ? "v2-archive-panel" : "v2-ledger-panel"}>
                <CardContent className="grid gap-3 p-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <div>
                      <p className="font-semibold text-primary">Contract #{contract.id}</p>
                      <p className="text-muted-foreground">{contract.customers?.first_name} {contract.customers?.last_name} · Lot {contract.parcels?.lot_number ?? "N/A"}</p>
                    </div>
                    <Badge tone={contractStatusTone(contract)}>{contractStatusLabel(contract)}</Badge>
                  </div>
                  <div className="grid gap-2 border-t border-border/80 pt-3 sm:grid-cols-3">
                    <ContractFact label="Price" value={money(contract.final_purchase_price)} />
                    <ContractFact label="Paid" value={money(paid)} />
                    <ContractFact label="Balance" value={money(balance)} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <div className="xl:sticky xl:top-6">
          <ContractForm />
        </div>
      </div>
    </section>
  );
}

function ContractFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 v2-money">{value}</p>
    </div>
  );
}
