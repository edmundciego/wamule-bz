import { useQueries } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { money } from "../lib/utils";

export function DashboardPage() {
  const results = useQueries({
    queries: [
      { queryKey: ["parcels"], queryFn: async () => (await supabase.from("parcels").select("*")).data ?? [] },
      { queryKey: ["applications"], queryFn: async () => (await supabase.from("applications").select("*")).data ?? [] },
      { queryKey: ["transactions"], queryFn: async () => (await supabase.from("transactions").select("*")).data ?? [] },
      { queryKey: ["balances"], queryFn: async () => (await supabase.from("customer_balance_view").select("*")).data ?? [] },
    ],
  });
  const isLoading = results.some((result) => result.isLoading);
  const error = results.find((result) => result.error)?.error as Error | undefined;
  const parcels = results[0].data ?? [];
  const applications = results[1].data ?? [];
  const transactions = results[2].data ?? [];
  const balances = results[3].data ?? [];
  const totalRevenue = transactions.reduce((sum, item) => sum + Number(item.amount), 0);
  const overdueBalance = balances.reduce((sum, item) => sum + Number(item.land_balance ?? 0), 0);

  return (
    <>
      <PageHeader title="Dashboard" description="Operational snapshot for Phase 1." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={error.message} /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Total lots" value={parcels.length} />
        <Metric title="Available lots" value={parcels.filter((lot) => lot.status === "Available").length} />
        <Metric title="Reserved lots" value={parcels.filter((lot) => lot.status === "Reserved").length} />
        <Metric title="Sold lots" value={parcels.filter((lot) => lot.status === "Sold").length} />
        <Metric title="Pending applications" value={applications.filter((app) => app.status === "Pending Review").length} />
        <Metric title="Revenue collected" value={money(totalRevenue)} />
        <Metric title="Open land balances" value={money(overdueBalance)} />
        <Metric title="Community delinquency" value={balances.filter((row) => Number(row.community_paid) <= 0).length} />
      </div>
    </>
  );
}

function Metric({ title, value }: { title: string; value: string | number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-display text-3xl font-semibold text-primary">{value}</p>
      </CardContent>
    </Card>
  );
}
