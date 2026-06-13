import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ContractForm } from "../components/forms/ContractForm";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";

export function CustomerDetailPage() {
  const { id } = useParams();
  const customerId = Number(id);
  const { data, isLoading, error } = useQuery({
    queryKey: ["customer-detail", customerId],
    queryFn: async () => {
      const { data: customer, error: queryError } = await supabase
        .from("customers")
        .select("*, applications(*, parcels(*)), contracts(*, parcels(*)), transactions(*)")
        .eq("id", customerId)
        .single();
      if (queryError) throw queryError;
      return customer;
    },
    enabled: Number.isFinite(customerId),
  });
  const landPayments =
    data?.transactions?.filter((item: { transaction_type: string }) =>
      ["Down Payment", "Land Installment"].includes(item.transaction_type),
    ) ?? [];
  const communityPayments =
    data?.transactions?.filter((item: { transaction_type: string }) =>
      ["Garbage Fee", "Road Maintenance"].includes(item.transaction_type),
    ) ?? [];

  return (
    <>
      <PageHeader
        title={data ? `${data.first_name} ${data.last_name}` : "Customer"}
        description="Customer profile, contract documents, and separate ledgers."
        action={
          data ? (
            <div className="flex flex-wrap gap-2">
              <ButtonLink to={`/documents/balance/${customerId}`}>Balance statement</ButtonLink>
              <ButtonLink to={`/documents/ledger/${customerId}`}>Ledger statement</ButtonLink>
            </div>
          ) : null
        }
      />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {data ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <div className="grid gap-6">
            <Card>
              <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm">
                <p>Phone: {data.phone}</p>
                <p>Email: {data.email ?? "Not provided"}</p>
                <p>Address: {data.address ?? "Not provided"}</p>
                <p>Originating lot: {data.applications?.parcels?.lot_number ?? "Not set"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Contracts</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                {data.contracts?.map((contract: {
                  id: number;
                  is_active: boolean;
                  final_purchase_price: number;
                  monthly_payment: number;
                  term_months: number;
                  payment_due_day: number;
                  signed_contract_file_path: string | null;
                }) => (
                  <div key={contract.id} className="rounded-md border p-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <strong>Contract #{contract.id}</strong>
                      <Badge tone={contract.is_active ? "green" : "gray"}>{contract.is_active ? "Active" : "Closed"}</Badge>
                    </div>
                    <p>Price: {money(contract.final_purchase_price)} | Monthly: {money(contract.monthly_payment)}</p>
                    <p>Term: {contract.term_months} months | Due day: {contract.payment_due_day}</p>
                    <p>Signed file: {contract.signed_contract_file_path ?? "Not uploaded"}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Ledger title="Land Payment History" rows={landPayments} />
            <Ledger title="Community Fee History" rows={communityPayments} />
          </div>
          <div className="grid content-start gap-6">
            <PaymentForm customerId={customerId} />
            <ContractForm customerId={customerId} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function Ledger({ title, rows }: { title: string; rows: Array<{ id: number; transaction_type: string; amount: number; created_at: string; receipt_file_path: string | null }> }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No transactions recorded.</p> : null}
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap justify-between gap-3 rounded-md border p-3 text-sm">
            <span>{row.transaction_type} on {formatDate(row.created_at)}</span>
            <div className="flex items-center gap-3">
              <Link className="font-medium text-primary hover:text-copper" to={`/documents/receipt/${row.id}`}>
                Receipt
              </Link>
              <span className="font-medium">{money(row.amount)}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ButtonLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to}>
      <Button type="button" variant="secondary">{children}</Button>
    </Link>
  );
}
