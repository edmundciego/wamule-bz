import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Clipboard, ExternalLink, Mail, RefreshCw, XCircle } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { cn, formatDate } from "../lib/utils";
import type { AiDailyBrief, AppRole, BriefActionItem, BriefActionItemStatus } from "../types/database";

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

  const { data: actionItems } = useQuery({
    queryKey: ["brief-action-items"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("brief_action_items")
        .select("*")
        .order("last_seen_on", { ascending: false })
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return data as BriefActionItem[];
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
    await queryClient.invalidateQueries({ queryKey: ["brief-action-items"] });
  }

  async function updateActionItem(id: number, status: Extract<BriefActionItemStatus, "Done" | "Dismissed">) {
    setActionError(null);
    setActionMessage(null);
    const patch = status === "Done"
      ? { status, resolved_at: new Date().toISOString(), dismissed_at: null }
      : { status, dismissed_at: new Date().toISOString(), resolved_at: null };
    const { error: updateError } = await supabase.from("brief_action_items").update(patch).eq("id", id);
    if (updateError) {
      setActionError(updateError.message);
      return;
    }
    setActionMessage(status === "Done" ? "Action item marked done." : "Action item dismissed.");
    await queryClient.invalidateQueries({ queryKey: ["brief-action-items"] });
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
            <Button type="button" variant="outline" disabled={!selectedBrief} onClick={() => void copyBrief()}>
              <Clipboard className="h-4 w-4" />
              Copy Brief
            </Button>
            <Button type="button" variant="outline" disabled>
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
        {actionMessage ? <div className="crm-success-panel p-3 text-sm">{actionMessage}</div> : null}
        {!canGenerateBrief ? (
          <div className="crm-warning-panel p-3 text-sm">
            Your role can view daily briefs but cannot generate new briefs.
          </div>
        ) : null}
        <div className="crm-info-panel p-4 text-sm">
          The Daily Operations Brief summarizes sales, reservations, applications, post-sales, payments, and recommended priorities for staff review.
        </div>

        {canGenerateBrief ? (
          <Card>
            <CardHeader>
              <CardTitle>Generate Custom Brief</CardTitle>
            </CardHeader>
            <CardContent className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
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
            <OpenActionItems items={(actionItems ?? []).filter((item) => item.status === "Open" || item.status === "In Progress")} canManage={canGenerateBrief} onUpdate={updateActionItem} />
            <BriefComparison brief={selectedBrief} previousBrief={previousBrief(briefs ?? [], selectedBrief.id)} actionItems={actionItems ?? []} />
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

function BriefComparison({
  brief,
  previousBrief,
  actionItems,
}: {
  brief: AiDailyBrief;
  previousBrief: AiDailyBrief | null;
  actionItems: BriefActionItem[];
}) {
  const currentAlerts = briefAlerts(brief).map((item) => normalizeAlertKey(item));
  const previousAlerts = previousBrief ? briefAlerts(previousBrief).map((item) => normalizeAlertKey(item)) : [];
  const newAlerts = currentAlerts.filter((item) => !previousAlerts.includes(item));
  const repeatedAlerts = currentAlerts.filter((item) => previousAlerts.includes(item));
  const resolvedAlerts = previousAlerts.filter((item) => !currentAlerts.includes(item));
  const currentPayments = currencyValue(brief.payments_summary);
  const previousPayments = previousBrief ? currencyValue(previousBrief.payments_summary) : null;
  const currentOutstanding = currencyValue(brief.collections_summary);
  const previousOutstanding = previousBrief ? currencyValue(previousBrief.collections_summary) : null;
  const currentLotCounts = lotCounts(brief.lots_summary);
  const previousLotCounts = previousBrief ? lotCounts(previousBrief.lots_summary) : null;

  return (
    <Card>
      <CardHeader><CardTitle>Compared to Previous Brief</CardTitle></CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-3">
        <ComparisonList title="New alerts" items={newAlerts} empty="No new alerts." />
        <ComparisonList title="Repeated alerts" items={repeatedAlerts} empty="No repeated alerts." />
        <ComparisonList title="Resolved or no longer appearing" items={resolvedAlerts} empty="No resolved alerts detected." />
        <ComparisonMetric label="Payment total change" value={changeLabel(currentPayments, previousPayments)} />
        <ComparisonMetric label="Outstanding balance change" value={changeLabel(currentOutstanding, previousOutstanding)} />
        <ComparisonMetric label="Lot status change" value={lotChangeLabel(currentLotCounts, previousLotCounts)} />
        <div className="crm-info-panel lg:col-span-3 p-3 text-sm">
          {actionItems.filter((item) => item.status === "Open" || item.status === "In Progress").length} open carryover items are being tracked after source records are rechecked.
        </div>
      </CardContent>
    </Card>
  );
}

function OpenActionItems({
  items,
  canManage,
  onUpdate,
}: {
  items: BriefActionItem[];
  canManage: boolean;
  onUpdate: (id: number, status: Extract<BriefActionItemStatus, "Done" | "Dismissed">) => Promise<void>;
}) {
  const groups = groupActionItems(items);

  return (
    <Card>
      <CardHeader><CardTitle>Open Items / Carryover</CardTitle></CardHeader>
      <CardContent className="grid gap-5">
        {items.length ? Object.entries(groups).map(([group, groupItems]) => (
          <div key={group} className="grid gap-3">
            <h3 className="text-sm font-semibold text-primary">{group}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {groupItems.map((item) => (
                <div key={item.id} className="rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{item.title}</p>
                      <p className="mt-1 text-muted-foreground">{item.details || "No extra details."}</p>
                    </div>
                    <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
                  </div>
                  <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <span>First seen: {safeFormatDate(item.first_seen_on)}</span>
                    <span>Last seen: {safeFormatDate(item.last_seen_on)}</span>
                    <span>Status: {item.status}</span>
                    <span>{item.related_table ? `Related: ${item.related_table} #${item.related_record_id ?? "N/A"}` : "Related: Not linked"}</span>
                  </div>
                  <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
                    {relatedHref(item) ? (
                      <a href={relatedHref(item) ?? undefined}>
                        <Button type="button" variant="outline" className="h-9">
                          <ExternalLink className="h-4 w-4" />
                          View Related Record
                        </Button>
                      </a>
                    ) : null}
                    {canManage ? (
                      <>
                        <Button type="button" variant="outline" className="h-9" onClick={() => void onUpdate(item.id, "Done")}>
                          <CheckCircle2 className="h-4 w-4" />
                          Mark Done
                        </Button>
                        <Button type="button" variant="ghost" className="h-9" onClick={() => void onUpdate(item.id, "Dismissed")}>
                          <XCircle className="h-4 w-4" />
                          Dismiss
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )) : <p className="text-sm text-muted-foreground">No open carryover action items.</p>}
      </CardContent>
    </Card>
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
          <Meta label="Generated" value={safeFormatDate(brief.created_at)} />
          <Meta label="Generated by" value={brief.generated_by ?? "Not recorded"} />
          <Meta label="Sent" value={brief.sent_at ? safeFormatDate(brief.sent_at) : "Not sent"} />
        </div>
        <div className="crm-info-panel p-4">
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
  const alerts = briefAlerts(brief);
  const recommendedActions = briefRecommendedActions(brief);
  const expandedSections = alerts.filter(isBriefSection);
  const alertItems = alerts.filter((item) => !isBriefSection(item));
  const sections = [
    ["Applications / Leads", brief.applications_summary],
    ["Lots", brief.lots_summary],
    ["Payments", brief.payments_summary],
    ["Contracts", brief.contracts_summary],
    ["Collections", brief.collections_summary],
  ] as const;

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {expandedSections.length ? (
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Daily Operations Brief Sections</CardTitle>
            <p className="text-sm text-muted-foreground">
              Activity, current state, carryover work, and comparison are separated so old unresolved items are not presented as new activity.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {expandedSections.map((item, index) => (
              <div key={`${itemTitle(item)}-${index}`} className="crm-subpanel text-sm">
                <p className="font-semibold text-primary">{itemTitle(item)}</p>
                <p className="mt-1 leading-6 text-muted-foreground">{itemDetail(item)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {sections.map(([title, content]) => (
        <Card key={title}>
          <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
          <CardContent><p className="text-sm leading-6 text-foreground">{content || "No notable activity for this section."}</p></CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader><CardTitle>Alerts</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {alertItems.length ? alertItems.map((item, index) => <AlertItem key={index} item={item} />) : <p className="text-sm text-muted-foreground">No alerts listed.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recommended Priorities</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {recommendedActions.length ? recommendedActions.map((item, index) => {
            const key = `${brief.id}-${index}`;
            return (
              <label key={key} className="flex gap-3 rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
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
          <div className="max-w-full overflow-x-auto">
            <table className="crm-table min-w-[640px] sm:min-w-[760px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Period Covered</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Generated at</th>
                  <th>View</th>
                </tr>
              </thead>
              <tbody>
                {briefs.map((brief) => (
                  <tr key={brief.id}>
                    <td>{safeFormatDate(brief.brief_date)}</td>
                    <td>{briefDisplay(brief).periodCovered}</td>
                    <td><Badge tone={statusTone(brief.status)}>{brief.status}</Badge></td>
                    <td>{brief.model}</td>
                    <td>{safeFormatDate(brief.created_at)}</td>
                    <td>
                      <Button type="button" variant={selectedBriefId === brief.id ? "primary" : "outline"} onClick={() => onSelect(brief.id)}>
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

function ComparisonList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="crm-subpanel">
      <p className="text-sm font-semibold text-primary">{title}</p>
      <div className="mt-2 grid gap-2">
        {items.length ? items.map((item) => <Badge key={item} tone="amber">{item}</Badge>) : <p className="text-sm text-muted-foreground">{empty}</p>}
      </div>
    </div>
  );
}

function ComparisonMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-subpanel">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function AlertItem({ item }: { item: unknown }) {
  return (
    <div className="rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
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
  const title = String(record?.title ?? record?.label ?? (typeof item === "string" ? item : "")).trim();
  return title || "Item";
}

function itemDetail(item: unknown) {
  const record = itemRecord(item);
  return String(record?.detail ?? record?.description ?? "").trim();
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

function severityTone(severity: BriefActionItem["severity"]) {
  if (severity === "Red") return "red";
  if (severity === "Amber") return "amber";
  return "blue";
}

function groupActionItems(items: BriefActionItem[]) {
  const orderedGroups = [
    "Buyer follow-ups",
    "Reservation readiness",
    "Post-sales",
    "Collections handoff",
    "Missing receipt numbers",
    "Missing transfer proof",
    "Missing signed contracts",
    "Lot conflicts",
    "Overdue accounts",
    "Open payment requests",
    "Other",
  ];
  return items.reduce<Record<string, BriefActionItem[]>>((groups, item) => {
    const group = orderedGroups.includes(item.source_type) ? item.source_type : "Other";
    groups[group] = groups[group] ?? [];
    groups[group].push(item);
    return groups;
  }, {});
}

function relatedHref(item: BriefActionItem) {
  if (!item.related_table || !item.related_record_id) return null;
  if (item.related_table === "customers") return `/customers/${item.related_record_id}`;
  if (item.related_table === "contracts") return `/contracts/${item.related_record_id}`;
  if (item.related_table === "applications") return "/applications";
  if (item.related_table === "transactions") return "/payments";
  if (item.related_table === "parcels") return "/lots";
  if (["follow_up_tasks", "lot_reservations", "leads"].includes(item.related_table)) return "/leads";
  if (["post_sales_tasks", "post_sales_checklists", "payment_requests"].includes(item.related_table)) return item.related_record_id ? "/customers" : null;
  return null;
}

function statusTone(status: AiDailyBrief["status"]) {
  if (status === "Generated") return "green";
  if (status === "Sent") return "blue";
  if (status === "Failed") return "red";
  return "gray";
}

function formatBriefForClipboard(brief: AiDailyBrief) {
  const display = briefDisplay(brief);
  const alerts = briefAlerts(brief);
  const recommendedActions = briefRecommendedActions(brief);
  const expandedSections = alerts.filter(isBriefSection);
  const alertItems = alerts.filter((item) => !isBriefSection(item));
  const activity = sectionText(expandedSections, "Activity During Period");
  const currentSnapshot = sectionText(expandedSections, "Current Snapshot");
  const carryover = sectionText(expandedSections, "Open Items / Carryover");
  const comparison = sectionText(expandedSections, "Compared to Previous Brief");

  return [
    display.title,
    `Period Covered: ${display.periodCovered}`,
    `Status: ${brief.status}`,
    `Model: ${brief.model}`,
    "",
    "Executive Summary",
    brief.summary,
    "",
    "Activity During Period",
    activity || "No period activity section recorded.",
    "",
    "Current Snapshot",
    currentSnapshot || "No current snapshot section recorded.",
    "",
    "Open Items / Carryover",
    carryover || "No carryover section recorded.",
    "",
    "Compared to Previous Brief",
    comparison || "No comparison section recorded.",
    "",
    "Applications / Leads",
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
    alertItems.map((item) => `- ${itemTitle(item)}${itemDetail(item) ? `: ${itemDetail(item)}` : ""}`).join("\n") || "- None",
    "",
    "Recommended Priorities",
    recommendedActions.map((item) => `- ${itemTitle(item)}${itemDetail(item) ? `: ${itemDetail(item)}` : ""}`).join("\n") || "- None",
  ].join("\n");
}

function sectionText(sections: unknown[], title: string) {
  const match = sections.find((item) => itemTitle(item).toLowerCase() === title.toLowerCase());
  return match ? itemDetail(match) : "";
}

function previousBrief(briefs: AiDailyBrief[], selectedBriefId: number) {
  const index = briefs.findIndex((brief) => brief.id === selectedBriefId);
  return index >= 0 ? briefs[index + 1] ?? null : null;
}

function normalizeAlertKey(item: unknown) {
  return itemTitle(item).trim() || "Alert";
}

function isBriefSection(item: unknown) {
  return String(itemRecord(item)?.kind ?? "").toLowerCase() === "section";
}

function briefAlerts(brief: AiDailyBrief) {
  return Array.isArray(brief.alerts) ? brief.alerts : [];
}

function briefRecommendedActions(brief: AiDailyBrief) {
  return Array.isArray(brief.recommended_actions) ? brief.recommended_actions : [];
}

function currencyValue(text: string) {
  const match = text.match(/\$[\d,]+(?:\.\d{2})?/);
  return match ? Number(match[0].replace(/[$,]/g, "")) : null;
}

function changeLabel(current: number | null, previous: number | null) {
  if (current == null || previous == null) return "Not enough comparable data.";
  const difference = current - previous;
  if (difference === 0) return "No change detected.";
  const formatted = new Intl.NumberFormat("en-BZ", { style: "currency", currency: "BZD" }).format(Math.abs(difference));
  return difference > 0 ? `Up ${formatted}` : `Down ${formatted}`;
}

function lotCounts(summary: string) {
  const available = /(\d+)\s+available/i.exec(summary)?.[1];
  const reserved = /(\d+)\s+reserved/i.exec(summary)?.[1];
  const sold = /(\d+)\s+sold/i.exec(summary)?.[1];
  return {
    available: available ? Number(available) : null,
    reserved: reserved ? Number(reserved) : null,
    sold: sold ? Number(sold) : null,
  };
}

function lotChangeLabel(
  current: ReturnType<typeof lotCounts>,
  previous: ReturnType<typeof lotCounts> | null,
) {
  if (!previous) return "No previous brief selected for comparison.";
  const parts = (["available", "reserved", "sold"] as const).flatMap((key) => {
    if (current[key] == null || previous[key] == null || current[key] === previous[key]) return [];
    const diff = Number(current[key]) - Number(previous[key]);
    return `${key}: ${diff > 0 ? "+" : ""}${diff}`;
  });
  return parts.length ? parts.join(", ") : "No lot count change detected.";
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

type CalendarDate = { year: number; month: number; day: number };

function briefDisplay(brief: AiDailyBrief) {
  const periodStart = calendarDate(brief.period_start);
  const periodEnd = finalIncludedDate(brief.period_end);
  const briefDate = calendarDate(brief.brief_date);
  let periodCovered = "Period not recorded";
  let titlePrefix = "Custom Brief";
  if (periodStart && periodEnd) {
    const isSingleDay = sameCalendarDate(periodStart, periodEnd);
    periodCovered = isSingleDay
      ? formatCalendarDate(periodStart)
      : `${formatCalendarDate(periodStart)} to ${formatCalendarDate(periodEnd)}`;
    titlePrefix = isSingleDay ? "Morning Brief" : "Custom Brief";
  }

  return {
    title: `${titlePrefix} - ${briefDate ? formatCalendarDate(briefDate) : "Date not recorded"}`,
    periodCovered,
  };
}

function finalIncludedDate(value: string) {
  const date = calendarDate(value);
  if (!date) return null;
  if (isExclusiveDateOnlyEnd(value)) {
    date.day -= 1;
    return normalizeCalendarDate(date);
  }
  return date;
}

function isExclusiveDateOnlyEnd(rawValue: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(rawValue);
}

function calendarDate(value: string | Date): CalendarDate | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return normalizeCalendarDate({ year, month, day });
  }

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
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

function normalizeCalendarDate(value: CalendarDate): CalendarDate {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function sameCalendarDate(a: CalendarDate | null, b: CalendarDate | null) {
  if (!a || !b) return false;
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function formatCalendarDate(date: CalendarDate) {
  return new Intl.DateTimeFormat("en-BZ", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(Date.UTC(date.year, date.month - 1, date.day, 12)),
  );
}

function safeFormatDate(value: string | null | undefined) {
  try {
    return formatDate(value);
  } catch {
    return "Date not recorded";
  }
}
