import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Card, CardContent } from "../components/ui/Card";
import { Input } from "../components/ui/Field";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { money } from "../lib/utils";

export function CustomersPage() {
  const [search, setSearch] = useState("");
  const [customersResult, balancesResult] = useQueries({
    queries: [
      {
        queryKey: ["customers-list"],
        queryFn: async () => {
      const { data: customers, error: queryError } = await supabase
        .from("customers")
        .select("*, applications(parcel_id, parcels(lot_number)), contracts(id, is_active)")
        .order("last_name");
      if (queryError) throw queryError;
      return customers;
        },
      },
      {
        queryKey: ["customer-balances"],
        queryFn: async () => {
          const { data: balances, error: queryError } = await supabase.from("customer_balance_view").select("*");
          if (queryError) throw queryError;
          return balances;
        },
      },
    ],
  });
  const data = customersResult.data;
  const balances = balancesResult.data ?? [];
  const isLoading = customersResult.isLoading || balancesResult.isLoading;
  const error = customersResult.error ?? balancesResult.error;
  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    return data?.filter((customer) =>
      `${customer.first_name} ${customer.last_name} ${customer.phone} ${customer.email ?? ""}`.toLowerCase().includes(query),
    );
  }, [data, search]);

  return (
    <>
      <PageHeader title="Customers" description="Approved customers and account standing." action={<Input placeholder="Search customers" value={search} onChange={(event) => setSearch(event.target.value)} />} />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {filtered?.length === 0 ? <EmptyState title="No customers found" /> : null}
      <div className="grid gap-3">
        {filtered?.map((customer) => {
          const balance = balances.find((row) => row.customer_id === customer.id);
          return (
            <Link key={customer.id} to={`/customers/${customer.id}`}>
              <Card className="transition hover:border-primary">
                <CardContent className="grid gap-3 p-4 sm:grid-cols-5 sm:items-center">
                  <div className="sm:col-span-2">
                    <p className="font-medium">{customer.first_name} {customer.last_name}</p>
                    <p className="text-sm text-muted-foreground">{customer.phone} {customer.email ? `| ${customer.email}` : ""}</p>
                  </div>
                  <p className="text-sm">Land balance: {money(balance?.land_balance ?? 0)}</p>
                  <p className="text-sm">Community paid: {money(balance?.community_paid ?? 0)}</p>
                  <p className="text-sm">Active contracts: {customer.contracts?.filter((contract: { is_active: boolean }) => contract.is_active).length ?? 0}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
