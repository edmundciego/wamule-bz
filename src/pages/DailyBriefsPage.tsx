import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Clipboard, Mail, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { cn, formatDate } from "../lib/utils";
import type { AiDailyBrief, AppRole } from "../types/database";

export function DailyBriefsPage() {
  const queryClient = useQueryClient();
  const [selectedBriefId, setSelectedBriefId] = useState<number | null>(null);
  const [periodStart, setPeriodStart] = useState(todayInputValue());
  const [periodEnd, setPeriodEnd] = useState(todayInputValue());
  const [generating, setGenerating] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkedActions, setCheckedActions] = useState<Record<string, boolean>>({});

  const { data: sessionProfile } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
  });

  const { data: briefs, isLoading, error } = useQuery({
    queryKey: ["daily-briefs"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("ai_daily_briefs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(25);
      if (queryError) throw queryError;
      return data as AiDailyBrief[];
    },
  });

  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canGenerateBrief = currentRole === "Super Admin" || currentRole === "Admin";
  const selectedBrief = useMemo(
    () => briefs?.find((brief) => brief.id === selectedBriefId) ?? briefs?.[0] ?? null,
    [briefs, selectedBriefId],
  );

  async function generateBrief(body: { period_start?: string; period_end?: string }) {
    setActionError(null);
    setActionMessage(null);
    setGenerating(true);
    const { data, error: functionError } = await supabase.functions.invoke("generate-daily-brief", { body });
    setGenerating(false);
    if (functionError) {
      setActionError(functionError.message);
      return;
    }
    if (data?.error) {
      setActionError(String(data.error));
      return;
    }
    setActionMessage(String(data?.message ?? "Daily brief generated."));
    setSelectedBriefId(Number(data?.brief?.id ?? 0) || null);
    await queryClient.invalidateQueries({ queryKey: ["daily-briefs"] });
  }

  async function copyBrief() {
    if (!selectedBrief) return;
    setActionError(null);
    setActionMessage(null);
    try {
      await navigator.clipboard.writeText(formatBriefForClipboard(selectedBrief));
      setActionMessage("Brief copied to clipboard.");
    } catch {
      setActionError("Clipboard copy failed in this browser.");
    }
  }

  return (
    <>
      <PageHeader
        title="Daily Brief"
        description="Morning operational summary for Wamule Development."
        action={
          <div className="flex flex-wrap gap-2">
            {canGenerateBrief ? (
              <Button type="button" disabled={generating} onClick={() => void generateBrief({ period_start: todayInputValue(), period_end: todayInputValue() })}>
                <RefreshCw className={cn("h-4 w-4", generating && "animate-spin")} />
                {generating ? "Generating..." : "Generate Morning Brief"}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" disabled={!selectedBrief} onClick={() => void copyBrief()}>
              <Clipboard className="h-4 w-4" />
              Copy Brief
            </Button>
            <Button type="button" variant="secondary" disabled>
              <Mail className="h-4 w-4" />
              Email Brief
            </Button>
          </div>
        }
      />

      <div className="grid gap-6">
        {isLoading ? <LoadingState label="Loading daily briefs" /> : null}
        {error ? <ErrorState message={(error as Error).message} /> : null}
        {actionError ? <ErrorState message={actionError} /> : null}
        {actionMessage ? <div className="rounded-md border border-sage/30 bg-sage/15 p-3 text-sm text-primary">{actionMessage}</div> : null}
        {!canGenerateBrief ? (
          <div className="rounded-md border border-copper/30 bg-copper/10 p-3 text-sm text-copper">
            Your role can view daily briefs but cannot generate new briefs.
          </div>
        ) : null}

        {canGenerateBrief ? (
          <Card>
            <CardHeader>
              <CardTitle>Generate Custom Brief</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Field label="Start date">
                <Input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
              </Field>
              <Field label="End date">
                <Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
              </Field>
              <Button type="button" disabled={generating || !periodStart || !periodEnd} onClick={() => void generateBrief({ period_start: periodStart, period_end: periodEnd })}>
                <CalendarDays className="h-4 w-4" />
                Generate Custom Brief
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {selectedBrief ? (
          <>
            <LatestBriefCard brief={selectedBrief} />
            <BriefSections brief={selectedBrief} checkedActions={checkedActions} onToggleAction={(key) => setCheckedActions((current) => ({ ...current, [key]: !current[key] }))} />
          </>
        ) : !isLoading ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">No previous briefs have been generated yet.</CardContent>
          </Card>
        ) : null}

        <PreviousBriefs briefs={briefs ?? []} selectedBriefId={selectedBrief?.id ?? null} onSelect={setSelectedBriefId} />
      </div>
    </>
  );
}

function LatestBriefCard({ brief }: { brief: AiDailyBrief }) {
  const display = briefDisplay(brief);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Latest Brief</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">Assistant-generated guidance only. Admins remain responsible for reviewing source records and taking manual action.</p>
        </div>
        <Badge tone={statusTone(brief.status)}>{brief.status}</Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <Meta label="Brief" value={display.title} />
          <Meta label="Period Covered" value={display.periodCovered} />
          <Meta label="Model" value={brief.model} />
          <Meta label="Generated" value={formatDate(brief.created_at)} />
          <Meta label="Generated by" value={brief.generated_by ?? "Not recorded"} />
          <Meta label="Sent" value={brief.sent_at ? formatDate(brief.sent_at) : "Not sent"} />
        </div>
        <div className="rounded-md border border-primary/10 bg-ivory/50 p-4">
          <p className="text-sm font-semibold text-primary">Executive summary</p>
          <p className="mt-2 text-sm leading-6 text-foreground">{brief.summary}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function BriefSections({
  brief,
  checkedActions,
  onToggleAction,
}: {
  brief: AiDailyBrief;
  checkedActions: Record<string, boolean>;
  onToggleAction: (key: string) => void;
}) {
  const sections = [
    ["Applications", brief.applications_summary],
    ["Lots", brief.lots_summary],
    ["Payments", brief.payments_summary],
    ["Contracts", brief.contracts_summary],
    ["Collections", brief.collections_summary],
  ] as const;

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {sections.map(([title, content]) => (
        <Card key={title}>
          <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
          <CardContent><p className="text-sm leading-6 text-foreground">{content || "No notable activity for this section."}</p></CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader><CardTitle>Alerts</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {brief.alerts.length ? brief.alerts.map((item, index) => <AlertItem key={index} item={item} />) : <p className="text-sm text-muted-foreground">No alerts listed.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recommended Actions</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {brief.recommended_actions.length ? brief.recommended_actions.map((item, index) => {
            const key = `${brief.id}-${index}`;
            return (
              <label key={key} className="flex gap-3 rounded-md border p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-border"
                  checked={Boolean(checkedActions[key])}
                  onChange={() => onToggleAction(key)}
                />
                <span className={cn("grid gap-1", checkedActions[key] && "text-muted-foreground line-through")}>
                  <span className="font-medium">{itemTitle(item)}</span>
                  <span className="text-muted-foreground">{itemDetail(item)}</span>
                </span>
              </label>
            );
          }) : <p className="text-sm text-muted-foreground">No recommended actions listed.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function PreviousBriefs({
  briefs,
  selectedBriefId,
  onSelect,
}: {
  briefs: AiDailyBrief[];
  selectedBriefId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Previous Briefs</CardTitle></CardHeader>
      <CardContent>
        {briefs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No previous briefs.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b text-xs uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Period Covered</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Generated at</th>
                  <th className="py-2 pr-3">View</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {briefs.map((brief) => (
                  <tr key={brief.id}>
                    <td className="py-3 pr-3">{formatDate(brief.brief_date)}</td>
                    <td className="py-3 pr-3">{briefDisplay(brief).periodCovered}</td>
                    <td className="py-3 pr-3"><Badge tone={statusTone(brief.status)}>{brief.status}</Badge></td>
                    <td className="py-3 pr-3">{brief.model}</td>
                    <td className="py-3 pr-3">{formatDate(brief.created_at)}</td>
                    <td className="py-3 pr-3">
                      <Button type="button" variant={selectedBriefId === brief.id ? "primary" : "secondary"} onClick={() => onSelect(brief.id)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AlertItem({ item }: { item: unknown }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{itemTitle(item)}</p>
        <Badge tone={alertTone(item)}>{itemSeverity(item)}</Badge>
      </div>
      <p className="mt-1 text-muted-foreground">{itemDetail(item)}</p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-foreground">{value}</p>
    </div>
  );
}

function itemRecord(item: unknown) {
  return item && typeof item === "object" ? item as Record<string, unknown> : null;
}

function itemTitle(item: unknown) {
  const record = itemRecord(item);
  return String(record?.title ?? record?.label ?? (typeof item === "string" ? item : "Item"));
}

function itemDetail(item: unknown) {
  const record = itemRecord(item);
  return String(record?.detail ?? record?.description ?? "");
}

function itemSeverity(item: unknown) {
  return String(itemRecord(item)?.severity ?? "info");
}

function alertTone(item: unknown) {
  const severity = itemSeverity(item).toLowerCase();
  if (severity.includes("red") || severity.includes("high") || severity.includes("urgent")) return "red";
  if (severity.includes("green") || severity.includes("ok")) return "green";
  if (severity.includes("blue") || severity.includes("info")) return "blue";
  return "amber";
}

function statusTone(status: AiDailyBrief["status"]) {
  if (status === "Generated") return "green";
  if (status === "Sent") return "blue";
  if (status === "Failed") return "red";
  return "gray";
}

function formatBriefForClipboard(brief: AiDailyBrief) {
  const display = briefDisplay(brief);

  return [
    display.title,
    `Period Covered: ${display.periodCovered}`,
    `Status: ${brief.status}`,
    `Model: ${brief.model}`,
    "",
    "Executive Summary",
    brief.summary,
    "",
    "Applications",
    brief.applications_summary,
    "",
    "Lots",
    brief.lots_summary,
    "",
    "Payments",
    brief.payments_summary,
    "",
    "Contracts",
    brief.contracts_summary,
    "",
    "Collections",
    brief.collections_summary,
    "",
    "Alerts",
    brief.alerts.map((item) => `- ${itemTitle(item)}${itemDetail(item) ? `: ${itemDetail(item)}` : ""}`).join("\n") || "- None",
    "",
    "Recommended Actions",
    brief.recommended_actions.map((item) => `- ${itemTitle(item)}${itemDetail(item) ? `: ${itemDetail(item)}` : ""}`).join("\n") || "- None",
  ].join("\n");
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function briefDisplay(brief: AiDailyBrief) {
  const periodStart = calendarDate(brief.period_start);
  const periodEnd = finalIncludedDate(brief.period_end);
  const periodCovered = sameCalendarDate(periodStart, periodEnd)
    ? formatCalendarDate(periodStart)
    : `${formatCalendarDate(periodStart)} to ${formatCalendarDate(periodEnd)}`;
  const titlePrefix = sameCalendarDate(periodStart, periodEnd) ? "Morning Brief" : "Custom Brief";

  return {
    title: `${titlePrefix} - ${formatCalendarDate(calendarDate(brief.brief_date))}`,
    periodCovered,
  };
}

function finalIncludedDate(value: string) {
  const date = calendarDate(value);
  if (isExclusiveDateOnlyEnd(value)) {
    date.day -= 1;
    return normalizeCalendarDate(date);
  }
  return date;
}

function isExclusiveDateOnlyEnd(rawValue: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(rawValue);
}

function calendarDate(value: string | Date) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return { year, month, day };
  }

  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Belize",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function normalizeCalendarDate(value: { year: number; month: number; day: number }) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function sameCalendarDate(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function formatCalendarDate(date: { year: number; month: number; day: number }) {
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(Date.UTC(date.year, date.month - 1, date.day, 12)),
  );
}
