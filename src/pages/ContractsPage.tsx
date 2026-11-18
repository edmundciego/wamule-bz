import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { ContractForm } from "../components/forms/ContractForm";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { Badge } from "../components/ui/Badge";
import { Card, CardContent } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { workspaceScopeKey } from "../lib/workspaceScope";
import { remainingLandBalance } from "../lib/financial";
import { money } from "../lib/utils";
import { getSessionAndProfile } from "../lib/data";
import type { Contract, ContractStatus } from "../types/database";

type ContractListRow = Contract & {
  customers?: { first_name: string | null; last_name: string | null } | null;
  parcels?: { lot_number: string | null } | null;
  transactions?: Array<{ amount: number; transaction_type: string; contract_id: number | null; status: string }> | null;
};
type ContractMetadataRow = {
  id: number;
  tenant_id: string;
  project_id: string;
  phase_id: string;
  customer_id: number;
  parcel_id: number;
  status: ContractStatus;
  is_active: boolean;
  created_at: string;
  customer_first_name: string;
  customer_last_name: string;
  lot_number: string | null;
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
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const scopeKey = workspaceScopeKey(workspace);
  const { data: sessionProfile, isLoading: profileLoading } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const role = sessionProfile?.profile?.role ?? null;
  const isTenantAdmin = role === "Admin" || role === "Super Admin";
  const isReadOnly = role === "Read Only";
  const canReadContracts = isTenantAdmin || isReadOnly;
  const { id: requestedContractId } = useParams<{ id?: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["contracts", scopeKey, role],
    queryFn: async () => {
      if (isReadOnly) {
        const { data: contracts, error: queryError } = await supabase
          .from("contract_scope_metadata")
          .select("*")
          .eq("tenant_id", workspace!.tenantId)
          .eq("project_id", workspace!.projectId)
          .eq("phase_id", workspace!.phaseId)
          .order("created_at", { ascending: false });
        if (queryError) throw queryError;
        return contracts as ContractMetadataRow[];
      }
      const { data: contracts, error: queryError } = await supabase
        .from("contracts")
        .select("*, customers(first_name, last_name), parcels(lot_number), transactions(amount, transaction_type)")
        .eq("tenant_id", workspace!.tenantId)
        .eq("project_id", workspace!.projectId)
        .eq("phase_id", workspace!.phaseId)
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return contracts as ContractListRow[];
    },
    enabled: Boolean(workspace && canReadContracts),
  });
  const { data: pendingVoidResolutions } = useQuery({
    queryKey: ["contract-void-resolutions", scopeKey],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("contract_void_resolutions")
        .select("contract_id")
        .eq("tenant_id", workspace!.tenantId)
        .eq("status", "pending");
      if (queryError) throw queryError;
      return rows as Array<{ contract_id: number }>;
    },
    enabled: Boolean(workspace && isTenantAdmin),
  });
  const pendingResolutionContractIds = new Set((pendingVoidResolutions ?? []).map((resolution) => resolution.contract_id));
  useEffect(() => {
    if (!requestedContractId || !data?.some((contract) => String(contract.id) === requestedContractId)) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>(`[data-contract-id="${requestedContractId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => window.clearTimeout(timer);
  }, [data, requestedContractId]);
  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Formal Records</p>
        <h1 className="v2-page-title">Contracts</h1>
        <p className="v2-page-description">{isReadOnly ? "Scoped contract metadata for this phase." : "Create purchase agreements and track active balances."}</p>
      </div>
      {workspaceLoading || profileLoading || (canReadContracts && isLoading) ? <LoadingState /> : null}
      {!workspace && !workspaceLoading ? <ErrorState message={workspaceError ?? "Choose an accessible workspace to view its contracts."} /> : null}
      {!profileLoading && workspace && !canReadContracts ? <ErrorState message="Contract terms and signed files are available only to a Tenant Admin or verified Super Admin." /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {canReadContracts ? <div className={`grid gap-6 ${isTenantAdmin ? "xl:grid-cols-[1fr_420px]" : ""}`}>
        <div className="grid content-start gap-3">
          {data?.map((contract) => {
            const adminContract = isTenantAdmin ? contract as ContractListRow : null;
            const metadata = contract as ContractMetadataRow;
            const balance = adminContract ? remainingLandBalance(adminContract, adminContract.transactions ?? []) : null;
            const paid = balance === null || !adminContract ? 0 : Number(adminContract.final_purchase_price) - balance;
            const archived = ["voided", "cancelled", "archived"].includes(contract.status);
            const customerName = isReadOnly
              ? `${metadata.customer_first_name} ${metadata.customer_last_name}`
              : `${adminContract?.customers?.first_name ?? ""} ${adminContract?.customers?.last_name ?? ""}`;
            const lotNumber = isReadOnly ? metadata.lot_number : adminContract?.parcels?.lot_number;
            return (
              <Card key={contract.id} data-contract-id={contract.id} className={`${archived ? "v2-archive-panel" : "v2-ledger-panel"} ${requestedContractId === String(contract.id) ? "ring-2 ring-accent ring-offset-2" : ""}`}>
                <CardContent className="grid gap-3 p-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <div>
                      <p className="font-semibold text-primary">Contract #{contract.id}</p>
                      <p className="text-muted-foreground">{customerName} · Lot {lotNumber ?? "N/A"}</p>
                    </div>
                    <Badge tone={contractStatusTone(contract)}>{contractStatusLabel(contract)}</Badge>
                    {pendingResolutionContractIds.has(contract.id) ? <Badge tone="red">Resolution Required</Badge> : null}
                  </div>
                  {adminContract ? <div className="grid gap-2 border-t border-border/80 pt-3 sm:grid-cols-3">
                    <ContractFact label="Price" value={money(adminContract.final_purchase_price)} />
                    <ContractFact label="Paid" value={money(paid)} />
                    <ContractFact label="Balance" value={balance === null ? "N/A" : money(balance)} />
                  </div> : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {isTenantAdmin ? <div className="xl:sticky xl:top-6"><ContractForm /></div> : null}
      </div> : null}
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
