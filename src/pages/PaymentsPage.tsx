import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardContent } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";

export function PaymentsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["payments"],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("transactions")
        .select("*, customers(first_name, last_name), contracts(id)")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return rows;
    },
  });
  return (
    <>
      <PageHeader title="Payments" description="Unified ledger for land installments and community fees." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <div className="grid content-start gap-3">
          {data?.map((payment) => (
            <Card key={payment.id}>
              <CardContent className="grid gap-2 p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-3">
                  <p className="font-medium">{payment.customers?.first_name} {payment.customers?.last_name}</p>
                  <Badge tone={["Down Payment", "Land Installment"].includes(payment.transaction_type) ? "blue" : "amber"}>{payment.transaction_type}</Badge>
                </div>
                <p>{money(payment.amount)} by {payment.collection_method} on {formatDate(payment.created_at)}</p>
                <p>Reference: {payment.bank_reference ?? "Cash"}</p>
                <Link className="text-sm font-medium text-primary hover:text-copper" to={`/documents/receipt/${payment.id}`}>
                  View receipt
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
        <PaymentForm />
      </div>
    </>
  );
}
