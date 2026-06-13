import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";

type PeriodFilter = "" | "this_month" | "last_month" | "q1" | "q2" | "q3" | "q4" | "this_year" | "last_year";

const periodOptions: { value: PeriodFilter; label: string }[] = [
  { value: "", label: "All time" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "q1", label: "Q1" },
  { value: "q2", label: "Q2" },
  { value: "q3", label: "Q3" },
  { value: "q4", label: "Q4" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
];

export function ReportsPage() {
  const [type, setType] = useState("");
  const [method, setMethod] = useState("");
  const [period, setPeriod] = useState<PeriodFilter>("this_month");
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports-transactions"],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("transactions")
        .select("*, customers(first_name, last_name)")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return rows;
    },
  });
  const periodRange = useMemo(() => getPeriodRange(period), [period]);
  const filtered = useMemo(
    () =>
      data?.filter((row) => {
        const matchesType = !type || row.transaction_type === type;
        const matchesMethod = !method || row.collection_method === method;
        const createdAt = new Date(row.created_at);
        const matchesPeriod =
          !periodRange || (createdAt >= periodRange.start && createdAt < periodRange.end);
        return matchesType && matchesMethod && matchesPeriod;
      }) ?? [],
    [data, method, periodRange, type],
  );
  const landTotal = filtered.filter((row) => ["Down Payment", "Land Installment"].includes(row.transaction_type)).reduce((sum, row) => sum + Number(row.amount), 0);
  const communityTotal = filtered.filter((row) => ["Garbage Fee", "Road Maintenance"].includes(row.transaction_type)).reduce((sum, row) => sum + Number(row.amount), 0);

  function exportCsv() {
    const header = "date,customer,type,method,amount,bank_reference\n";
    const body = filtered
      .map((row) => [
        row.created_at,
        `${row.customers?.first_name ?? ""} ${row.customers?.last_name ?? ""}`.trim(),
        row.transaction_type,
        row.collection_method,
        row.amount,
        row.bank_reference ?? "",
      ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wamuale-transactions.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader title="Reports" description="Revenue, customer balances, and transaction exports." action={<Button type="button" onClick={exportCsv}>Export CSV</Button>} />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Field label="Transaction type">
          <Select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">All</option>
            <option>Down Payment</option>
            <option>Land Installment</option>
            <option>Garbage Fee</option>
            <option>Road Maintenance</option>
          </Select>
        </Field>
        <Field label="Collection method">
          <Select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="">All</option>
            <option>Cash</option>
            <option>Online Transfer</option>
          </Select>
        </Field>
        <Field label="Period">
          <Select value={period} onChange={(event) => setPeriod(event.target.value as PeriodFilter)}>
            {periodOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <ReportCard title="Total revenue" value={money(landTotal + communityTotal)} />
        <ReportCard title="Land payments" value={money(landTotal)} />
        <ReportCard title="Community fees" value={money(communityTotal)} />
      </div>
      <div className="mt-6 grid gap-3">
        {filtered.map((row) => (
          <Card key={row.id}>
            <CardContent className="grid gap-2 p-4 text-sm sm:grid-cols-4">
              <p>{formatDate(row.created_at)}</p>
              <p>{row.customers?.first_name} {row.customers?.last_name}</p>
              <p>{row.transaction_type}</p>
              <p className="font-medium">{money(row.amount)}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function getPeriodRange(period: PeriodFilter) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  if (!period) return null;

  if (period === "this_month") {
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 1),
    };
  }

  if (period === "last_month") {
    return {
      start: new Date(year, month - 1, 1),
      end: new Date(year, month, 1),
    };
  }

  if (period === "this_year") {
    return {
      start: new Date(year, 0, 1),
      end: new Date(year + 1, 0, 1),
    };
  }

  if (period === "last_year") {
    return {
      start: new Date(year - 1, 0, 1),
      end: new Date(year, 0, 1),
    };
  }

  const quarterStartMonth = {
    q1: 0,
    q2: 3,
    q3: 6,
    q4: 9,
  }[period];

  return {
    start: new Date(year, quarterStartMonth, 1),
    end: new Date(year, quarterStartMonth + 3, 1),
  };
}

function ReportCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm text-muted-foreground">{title}</CardTitle></CardHeader>
      <CardContent><p className="text-2xl font-semibold">{value}</p></CardContent>
    </Card>
  );
}
