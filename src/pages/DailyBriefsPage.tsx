import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Clipboard, ExternalLink, Mail, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useCompanyProfile } from "../lib/brand";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { isOperationalAttentionCurrent } from "../lib/operationalAttention";
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
  const [showAllPriorities, setShowAllPriorities] = useState(false);
  const { companyName, isLoading: companyLoading, isUnavailable: companyUnavailable } = useCompanyProfile();

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

  const { data: revalidation = {}, isError: revalidationError } = useQuery({
    queryKey: ["brief-action-revalidation", (actionItems ?? []).map((item) => `${item.id}:${item.updated_at}`).join(",")],
    enabled: Boolean(actionItems?.length),
    queryFn: () => revalidateBriefItems(actionItems ?? []),
    staleTime: 30_000,
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
    <section className="v2-page-shell">
      <div className="v2-page-header flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="v2-page-kicker">Daily Operations</p>
          <h1 className="v2-page-title">Daily Brief</h1>
          <p className="v2-page-description">{companyLoading || companyUnavailable ? "Morning operational summary." : `Morning operational summary for ${companyName}.`}</p>
        </div>
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
      </div>

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
        <div className="v2-advisor-panel p-4 text-sm text-primary">
          The Daily Operations Brief summarizes sales, reservations, applications, post-sales, payments, and recommended priorities for staff review.
        </div>

        {canGenerateBrief ? (
          <Card className="v2-workflow-panel">
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
            <SummaryCards brief={selectedBrief} previousBrief={previousBrief(briefs ?? [], selectedBrief.id)} actionItems={actionItems ?? []} />
            <TodayPriorities
              items={(actionItems ?? []).filter((item) => item.status === "Open" || item.status === "In Progress")}
              revalidation={revalidation}
              canManage={canGenerateBrief}
              showAll={showAllPriorities}
              onToggleShowAll={() => setShowAllPriorities((current) => !current)}
              onUpdate={updateActionItem}
            />
            <WhatChanged brief={selectedBrief} />
            <OpenActionItems items={(actionItems ?? []).filter((item) => item.status === "Open" || item.status === "In Progress")} revalidation={revalidation} canManage={canGenerateBrief} onUpdate={updateActionItem} />
            {revalidationError ? <div className="crm-warning-panel flex flex-wrap items-center justify-between gap-3 p-3 text-sm"><span>Some source records could not be revalidated. Retry before acting on an alert.</span><Button type="button" variant="outline" className="h-8" onClick={() => void queryClient.invalidateQueries({ queryKey: ["brief-action-revalidation"] })}>Retry</Button></div> : null}
            <BriefComparison brief={selectedBrief} previousBrief={previousBrief(briefs ?? [], selectedBrief.id)} actionItems={actionItems ?? []} />
            <BriefSections brief={selectedBrief} actionItems={actionItems ?? []} checkedActions={checkedActions} onToggleAction={(key) => setCheckedActions((current) => ({ ...current, [key]: !current[key] }))} />
          </>
        ) : !isLoading ? (
          <Card className="v2-advisor-panel">
            <CardContent className="p-6 text-sm text-muted-foreground">No previous briefs have been generated yet.</CardContent>
          </Card>
        ) : null}

        <PreviousBriefs briefs={briefs ?? []} selectedBriefId={selectedBrief?.id ?? null} onSelect={setSelectedBriefId} />
      </div>
    </section>
  );
}

function SummaryCards({
  brief,
  previousBrief,
  actionItems,
}: {
  brief: AiDailyBrief;
  previousBrief: AiDailyBrief | null;
  actionItems: BriefActionItem[];
}) {
  const sections = structuredSections(brief);
  const openCount = actionItems.filter((item) => item.status === "Open" || item.status === "In Progress").length;
  const resolvedSincePrevious = resolvedSince(actionItems, previousBrief);
  const outstanding = currencyValue(brief.collections_summary);
  const cards = [
    { label: "New applications / leads", value: countFromText(sections.activity, /(\d+)\s+new applications\/leads/i, countFromText(brief.applications_summary, /(\d+)\s+new applications/i)) },
    { label: "Payments logged", value: countFromText(sections.activity, /(\d+)\s+payments logged/i, countFromText(brief.payments_summary, /(\d+)\s+payments logged/i)) },
    { label: "New contracts", value: countFromText(sections.activity, /(\d+)\s+contracts created/i, countFromText(brief.contracts_summary, /(\d+)\s+new contracts/i)) },
    { label: "Open action items", value: String(openCount) },
    { label: "Resolved since last brief", value: String(resolvedSincePrevious) },
    { label: "Outstanding balance", value: outstanding == null ? "Not available" : moneyLabel(outstanding) },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.label} className="v2-ledger-panel">
          <CardContent className="p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-primary">{card.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TodayPriorities({
  items,
  revalidation,
  canManage,
  showAll,
  onToggleShowAll,
  onUpdate,
}: {
  items: BriefActionItem[];
  revalidation: Record<number, BriefRevalidationState>;
  canManage: boolean;
  showAll: boolean;
  onToggleShowAll: () => void;
  onUpdate: (id: number, status: Extract<BriefActionItemStatus, "Done" | "Dismissed">) => Promise<void>;
}) {
  const sorted = sortActionItems(items);
  const visible = showAll ? sorted : sorted.slice(0, 5);

  return (
    <Card className="v2-advisor-panel">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Today's Priorities</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Highest-priority open work, sorted Red, Amber, then Info.</p>
        </div>
        {sorted.length > 5 ? (
          <Button type="button" variant="outline" onClick={onToggleShowAll}>
            {showAll ? "Show Less" : `View All ${sorted.length}`}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {visible.length ? visible.map((item) => (
          <ActionItemCard key={item.id} item={item} revalidation={revalidation[item.id]} canManage={canManage} onUpdate={onUpdate} compact />
        )) : (
          <div className="crm-success-panel p-4 text-sm">No open priorities need attention right now.</div>
        )}
      </CardContent>
    </Card>
  );
}

function WhatChanged({ brief }: { brief: AiDailyBrief }) {
  const activity = structuredSections(brief).activity || fallbackActivityText(brief);
  const changes = activityItems(activity);

  return (
    <Card className="v2-archive-panel">
      <CardHeader>
        <CardTitle>What Changed</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">Only activity recorded during the selected period.</p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {changes.length ? changes.map((item) => (
          <div key={item} className="crm-subpanel text-sm">
            {item}
          </div>
        )) : (
          <div className="crm-info-panel p-4 text-sm">No new or updated records were detected during this brief period.</div>
        )}
      </CardContent>
    </Card>
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
  const currentAlerts = briefAlerts(brief).filter((item) => !isBriefSection(item)).map((item) => normalizeAlertKey(item));
  const previousAlerts = previousBrief ? briefAlerts(previousBrief).filter((item) => !isBriefSection(item)).map((item) => normalizeAlertKey(item)) : [];
  const newAlerts = currentAlerts.filter((item) => !previousAlerts.includes(item));
  const repeatedAlerts = currentAlerts.filter((item) => previousAlerts.includes(item));
  const resolvedAlerts = previousAlerts.filter((item) => !currentAlerts.includes(item));
  const currentPayments = currencyValue(brief.payments_summary);
  const previousPayments = previousBrief ? currencyValue(previousBrief.payments_summary) : null;
  const currentOutstanding = currencyValue(brief.collections_summary);
  const previousOutstanding = previousBrief ? currencyValue(previousBrief.collections_summary) : null;
  const currentLotCounts = lotCounts(brief.lots_summary);
  const previousLotCounts = previousBrief ? lotCounts(previousBrief.lots_summary) : null;
  const currentOpen = actionItems.filter((item) => item.status === "Open" || item.status === "In Progress").length;
  const previousOpen = previousBrief
    ? actionItems.filter((item) =>
      (item.status === "Open" || item.status === "In Progress") &&
      new Date(item.first_seen_on).getTime() <= new Date(previousBrief.brief_date).getTime()
    ).length
    : null;

  return (
    <Card className="v2-archive-panel">
      <CardHeader><CardTitle>Compared to Previous Brief</CardTitle></CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-3">
        <ComparisonMetric label="Open action item count" value={previousOpen == null ? `${currentOpen} open` : countChangeLabel(currentOpen, previousOpen)} />
        <ComparisonMetric label="Resolved item count" value={`${resolvedSince(actionItems, previousBrief)} resolved`} />
        <ComparisonMetric label="New / repeated issue count" value={`${newAlerts.length} new, ${repeatedAlerts.length} repeated`} />
        <ComparisonMetric label="Payment total change" value={changeLabel(currentPayments, previousPayments)} />
        <ComparisonMetric label="Outstanding balance change" value={changeLabel(currentOutstanding, previousOutstanding)} />
        <ComparisonMetric label="Lot status change" value={lotChangeLabel(currentLotCounts, previousLotCounts)} />
        <details className="crm-subpanel lg:col-span-3">
          <summary className="cursor-pointer text-sm font-semibold text-primary">Show comparison details</summary>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <ComparisonList title="New alerts" items={newAlerts} empty="No new alerts." />
            <ComparisonList title="Repeated alerts" items={repeatedAlerts} empty="No repeated alerts." />
            <ComparisonList title="Resolved or no longer appearing" items={resolvedAlerts} empty="No resolved alerts detected." />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function OpenActionItems({
  items,
  revalidation,
  canManage,
  onUpdate,
}: {
  items: BriefActionItem[];
  revalidation: Record<number, BriefRevalidationState>;
  canManage: boolean;
  onUpdate: (id: number, status: Extract<BriefActionItemStatus, "Done" | "Dismissed">) => Promise<void>;
}) {
  const groups = groupActionItems(items);
  const hasManyItems = items.length > 8;

  return (
    <Card className="v2-workflow-panel">
      <CardHeader>
        <CardTitle>Carryover Work</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">Unresolved items still open from current or previous briefs.</p>
      </CardHeader>
      <CardContent>
        {items.length ? (
          <details open={!hasManyItems} className="grid gap-5">
            <summary className="cursor-pointer text-sm font-semibold text-primary">
              {hasManyItems ? `Show ${items.length} open carryover items` : `${items.length} open carryover items`}
            </summary>
            <div className="mt-4 grid gap-5">
              {Object.entries(groups).filter(([, groupItems]) => groupItems.length).map(([group, groupItems]) => (
                <div key={group} className="grid gap-3">
                  <h3 className="text-sm font-semibold text-primary">{group}</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {groupItems.map((item) => (
                      <ActionItemCard key={item.id} item={item} revalidation={revalidation[item.id]} canManage={canManage} onUpdate={onUpdate} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : <p className="text-sm text-muted-foreground">No open carryover action items.</p>}
      </CardContent>
    </Card>
  );
}

function ActionItemCard({
  item,
  revalidation,
  canManage,
  onUpdate,
  compact = false,
}: {
  item: BriefActionItem;
  revalidation?: BriefRevalidationState;
  canManage: boolean;
  onUpdate: (id: number, status: Extract<BriefActionItemStatus, "Done" | "Dismissed">) => Promise<void>;
  compact?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium">{item.title}</p>
          <p className="mt-1 break-words text-muted-foreground">{item.details || "No extra details."}</p>
        </div>
        <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
      </div>
      {revalidation ? <div className="mt-2"><Badge tone={revalidationTone(revalidation)}>{revalidation}</Badge></div> : null}
      {!compact ? (
        <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <span>First seen: {safeFormatDate(item.first_seen_on)}</span>
          <span>Last seen: {safeFormatDate(item.last_seen_on)}</span>
          <span>Status: {item.status}</span>
          <span>{item.related_table ? `Related: ${item.related_table} #${item.related_record_id ?? "N/A"}` : "Related: Not linked"}</span>
        </div>
      ) : null}
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
  );
}

function LatestBriefCard({ brief }: { brief: AiDailyBrief }) {
  const display = briefDisplay(brief);

  return (
    <Card className="v2-advisor-panel">
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
        <div className="rounded-lg border border-secondary/20 bg-card/70 p-4">
          <p className="text-sm font-semibold text-primary">Executive summary</p>
          <p className="mt-2 text-sm leading-6 text-foreground">{brief.summary}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function BriefSections({
  brief,
  actionItems,
  checkedActions,
  onToggleAction,
}: {
  brief: AiDailyBrief;
  actionItems: BriefActionItem[];
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
    <Card className="v2-advisor-panel">
      <CardHeader>
        <CardTitle>Detailed Brief</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">Full AI/deterministic report sections and recommended actions.</p>
      </CardHeader>
      <CardContent>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-primary">Open detailed report</summary>
          <div className="mt-4 grid gap-6 xl:grid-cols-2">
            {expandedSections.length ? (
              <div className="grid gap-3 xl:col-span-2 md:grid-cols-2">
                {expandedSections.map((item, index) => (
                  <div key={`${itemTitle(item)}-${index}`} className="crm-subpanel text-sm">
                    <p className="font-semibold text-primary">{itemTitle(item)}</p>
                    <p className="mt-1 leading-6 text-muted-foreground">{itemDetail(item)}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {sections.map(([title, content]) => (
              <div key={title} className="crm-subpanel">
                <p className="text-sm font-semibold text-primary">{title}</p>
                <p className="mt-2 text-sm leading-6 text-foreground">{content || "No notable activity for this section."}</p>
              </div>
            ))}

            <div className="crm-subpanel">
              <p className="text-sm font-semibold text-primary">Alerts</p>
              <div className="mt-3 grid gap-3">
                {alertItems.length ? alertItems.map((item, index) => <AlertItem key={index} item={item} />) : <p className="text-sm text-muted-foreground">No alerts listed.</p>}
              </div>
            </div>

            <div className="crm-subpanel">
              <p className="text-sm font-semibold text-primary">Full Recommended Actions</p>
              <div className="mt-3 grid gap-3">
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
                        {(() => {
                          const sourceKey = String(itemRecord(item)?.source_key ?? "");
                          const linked = actionItems.find((actionItem) => actionItem.source_key === sourceKey);
                          const href = linked ? relatedHref(linked) : null;
                          return href ? <a className="text-xs font-semibold text-primary underline-offset-2 hover:underline" href={href}>Open source record</a> : null;
                        })()}
                      </span>
                    </label>
                  );
                }) : <p className="text-sm text-muted-foreground">No recommended actions listed.</p>}
              </div>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
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
    <Card className="v2-archive-panel">
      <CardHeader><CardTitle>Previous Briefs</CardTitle></CardHeader>
      <CardContent>
        {briefs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No previous briefs.</p>
        ) : (
          <div className="v2-table-wrap">
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
    "Overdue follow-ups",
    "Reservations and deposits",
    "Applications awaiting review",
    "Collections alerts",
    "Post-sales blockers",
    "Site visits",
    "Missing receipts",
    "Missing proof",
    "Missing signed contracts",
    "Lot conflicts",
    "Overdue accounts",
    "Other",
  ];
  return items.reduce<Record<string, BriefActionItem[]>>((groups, item) => {
    const group = carryoverGroupLabel(item);
    groups[group] = groups[group] ?? [];
    groups[group].push(item);
    return groups;
  }, orderedGroups.reduce<Record<string, BriefActionItem[]>>((groups, group) => ({ ...groups, [group]: [] }), {}));
}

function carryoverGroupLabel(item: BriefActionItem) {
  if (["overdue_follow_up", "follow_up_due_today"].includes(item.attention_kind ?? "")) return "Overdue follow-ups";
  if (["reservation_expiring", "deposit_overdue"].includes(item.attention_kind ?? "")) return "Reservations and deposits";
  if (item.attention_kind === "application_review") return "Applications awaiting review";
  if (item.attention_kind === "collection_alert") return "Collections alerts";
  if (["post_sales_blocker", "post_sales_task_overdue"].includes(item.attention_kind ?? "")) return "Post-sales blockers";
  if (["site_visit_today", "site_visit_upcoming"].includes(item.attention_kind ?? "")) return "Site visits";
  if (item.source_type === "Missing receipt numbers") return "Missing receipts";
  if (item.source_type === "Missing transfer proof") return "Missing proof";
  if (item.source_type === "Missing signed contracts") return "Missing signed contracts";
  if (item.source_type === "Lot conflicts") return "Lot conflicts";
  if (item.source_type === "Overdue accounts") return "Overdue accounts";
  return "Other";
}

function sortActionItems(items: BriefActionItem[]) {
  const rank: Record<BriefActionItem["severity"], number> = { Red: 0, Amber: 1, Info: 2 };
  return [...items].sort((a, b) => {
    const severity = rank[a.severity] - rank[b.severity];
    if (severity !== 0) return severity;
    return new Date(b.last_seen_on).getTime() - new Date(a.last_seen_on).getTime();
  });
}

function structuredSections(brief: AiDailyBrief) {
  const sections = briefAlerts(brief).filter(isBriefSection);
  return {
    activity: sectionText(sections, "Activity During Period"),
    currentSnapshot: sectionText(sections, "Current Snapshot"),
    carryover: sectionText(sections, "Open Items / Carryover"),
    comparison: sectionText(sections, "Compared to Previous Brief"),
  };
}

function activityItems(activity: string) {
  return activity
    .split(/(?<=\.)\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => /\b[1-9]\d*\b/.test(item));
}

function fallbackActivityText(brief: AiDailyBrief) {
  return [
    firstSentence(brief.applications_summary),
    firstSentence(brief.payments_summary),
    firstSentence(brief.contracts_summary),
    firstSentence(brief.lots_summary),
  ].filter(Boolean).join(" ");
}

function firstSentence(value: string) {
  return value.split(/(?<=\.)\s+/)[0]?.trim() ?? "";
}

function countFromText(text: string, pattern: RegExp, fallback = "0") {
  return pattern.exec(text)?.[1] ?? fallback;
}

function resolvedSince(items: BriefActionItem[], previousBrief: AiDailyBrief | null) {
  if (!previousBrief) return items.filter((item) => item.status === "Done" && item.resolved_at).length;
  const since = new Date(previousBrief.created_at).getTime();
  return items.filter((item) => item.status === "Done" && item.resolved_at && new Date(item.resolved_at).getTime() >= since).length;
}

type BriefRevalidationState = "Current" | "Resolved since brief" | "Updated since brief" | "Source unavailable";
type DynamicSourceQuery = {
  select: (columns: string) => DynamicSourceQuery;
  eq: (column: string, value: string) => DynamicSourceQuery;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
};
type DynamicSourceClient = { from: (table: string) => DynamicSourceQuery };

async function revalidateBriefItems(items: BriefActionItem[]) {
  const result: Record<number, BriefRevalidationState> = {};
  await Promise.all(items.map(async (item) => {
    const table = item.source_entity_type ? sourceTable(item.source_entity_type) : item.related_table;
    const recordId = item.source_entity_id ?? item.related_record_id;
    if (!table || !recordId || !item.attention_kind) {
      result[item.id] = "Current";
      return;
    }
    const select = table === "transactions" ? "*, payment_documents(id)" : table === "follow_up_tasks" ? "*, leads(id, pipeline_stage)" : "*";
    const { data, error } = await (supabase as unknown as DynamicSourceClient).from(table).select(select).eq("id", recordId).maybeSingle();
    if (error || !data) {
      result[item.id] = "Source unavailable";
      return;
    }
    const current = isOperationalAttentionCurrent(
      { kind: item.attention_kind as Parameters<typeof isOperationalAttentionCurrent>[0]["kind"], dueAt: item.generated_due_at, currentStatus: item.generated_status ?? "" },
      data as Record<string, unknown>,
    );
    if (!current) {
      result[item.id] = "Resolved since brief";
      return;
    }
    const generatedAt = item.generated_source_updated_at ? new Date(item.generated_source_updated_at).getTime() : 0;
    const currentUpdatedAt = new Date(String((data as Record<string, unknown>).updated_at ?? "")).getTime();
    result[item.id] = generatedAt && currentUpdatedAt > generatedAt ? "Updated since brief" : "Current";
  }));
  return result;
}

function sourceTable(entityType: string) {
  const tableByType: Record<string, string> = {
    lead: "leads",
    follow_up_task: "follow_up_tasks",
    site_visit: "site_visits",
    application: "applications",
    reservation: "lot_reservations",
    payment: "transactions",
    payment_request: "payment_requests",
    customer: "customers",
    post_sales_task: "post_sales_tasks",
    post_sales_checklist: "post_sales_checklists",
  };
  return tableByType[entityType] ?? null;
}

function revalidationTone(state: BriefRevalidationState) {
  if (state === "Current") return "green" as const;
  if (state === "Resolved since brief") return "blue" as const;
  if (state === "Source unavailable") return "red" as const;
  return "amber" as const;
}

function countChangeLabel(current: number, previous: number) {
  const diff = current - previous;
  if (diff === 0) return `${current} open, no change`;
  return `${current} open (${diff > 0 ? "+" : ""}${diff})`;
}

function relatedHref(item: BriefActionItem) {
  if (item.destination_route) return item.destination_route;
  if (!item.related_table || !item.related_record_id) return null;
  if (item.related_table === "customers") return `/customers/${item.related_record_id}`;
  if (item.related_table === "contracts") return `/contracts/${item.related_record_id}`;
  if (item.related_table === "applications") return `/applications?application=${item.related_record_id}`;
  if (item.related_table === "transactions") return `/payments?payment=${item.related_record_id}`;
  if (item.related_table === "parcels") return "/lots";
  if (item.related_table === "follow_up_tasks") return `/leads?focus=followups&followup=${item.related_record_id}`;
  if (item.related_table === "lot_reservations") return `/leads?focus=reservations&reservation=${item.related_record_id}`;
  if (item.related_table === "leads") return `/leads?lead=${item.related_record_id}`;
  if (["post_sales_tasks", "post_sales_checklists"].includes(item.related_table)) return `/customers?tab=post-sales&record=${item.related_record_id}`;
  if (item.related_table === "payment_requests") return `/customers?tab=requests&request=${item.related_record_id}`;
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
  const formatted = moneyLabel(Math.abs(difference));
  return difference > 0 ? `Up ${formatted}` : `Down ${formatted}`;
}

function moneyLabel(value: number) {
  return new Intl.NumberFormat("en-BZ", { style: "currency", currency: "BZD" }).format(value);
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
