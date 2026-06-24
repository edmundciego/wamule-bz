import { useQuery } from "@tanstack/react-query";
import { ContractForm } from "../components/forms/ContractForm";
import { PageHeader } from "../components/layout/PageHeader";
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
    <>
      <PageHeader title="Contracts" description="Create purchase agreements and track active balances." />
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
            return (
              <Card key={contract.id}>
                <CardContent className="grid gap-2 p-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <p className="font-medium">Contract #{contract.id} - {contract.customers?.first_name} {contract.customers?.last_name}</p>
                    <Badge tone={contractStatusTone(contract)}>{contractStatusLabel(contract)}</Badge>
                  </div>
                  <p>Lot {contract.parcels?.lot_number} | Price {money(contract.final_purchase_price)} | Paid {money(paid)} | Balance {money(Number(contract.final_purchase_price) - paid)}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <ContractForm />
      </div>
    </>
  );
}
