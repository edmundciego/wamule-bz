import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  CircleDollarSign,
  ClipboardCheck,
  HandCoins,
  Landmark,
  ListChecks,
  MapPinned,
  Sparkles,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../components/ui/Badge";
import { SmartInsightList } from "../components/ui/SmartInsightsPanel";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { getSessionAndProfile } from "../lib/data";
import { canAggregateCompanyFinance, canReadFinance, effectiveFinanceScope, formatCurrencyAmount, summarizeAllocationRows, summarizeAmountsByCurrency, summarizeFeeCharges } from "../lib/financialReporting.mjs";
import { buildOperationalAttention, groupOperationalAttention, operationalAttentionInsights, type OperationalAttentionGroup, type OperationalAttentionItem } from "../lib/operationalAttention";
import { supabase } from "../lib/supabase";
import { workspaceScopeKey } from "../lib/workspaceScope";
import { cn, formatDate } from "../lib/utils";
import { isAvailableForSalesSelection, isExistingInventoryRecord, isRasterDetection } from "../../supabase/functions/_shared/parcel-provenance.mjs";
import type { FollowUpTask, Lead, LotReservation, PostSalesChecklist, PostSalesTask, SiteVisit } from "../types/database";

export function DashboardPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const { data: sessionProfile, isLoading: profileLoading } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const role = sessionProfile?.profile?.role ?? null;
  const [requestedFinanceScope, setRequestedFinanceScope] = useState<"phase" | "project" | "company">("phase");
  const financeScope = effectiveFinanceScope(role, requestedFinanceScope);
  const isCompanyAggregate = financeScope === "company";
  const isProjectAggregate = financeScope === "project";
  const canReadFinancials = canReadFinance(role);
  const canSeeContractBalances = role === "Admin" || role === "Super Admin";
  const scopeKey = `${workspaceScopeKey(workspace)}:${workspace?.mapExperienceMode ?? "sales"}:${financeScope}`;
  const results = useQueries({
    queries: [
      {
        queryKey: ["dashboard-parcels", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("parcels").select("*").eq("tenant_id", workspace!.tenantId);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query;
          if (error) throw error;
          return data ?? [];
        },
      },
      {
        queryKey: ["dashboard-applications", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("applications").select("*").eq("tenant_id", workspace!.tenantId);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query;
          if (error) throw error;
          return data ?? [];
        },
      },
      {
        queryKey: ["dashboard-allocations", scopeKey, role], enabled: Boolean(workspace && canReadFinancials),
        queryFn: async () => {
          if (role === "Read Only") {
            const { data, error } = await supabase.rpc("read_phase_payment_allocations_v1", {
              p_tenant_id: workspace!.tenantId,
              p_project_id: workspace!.projectId,
              p_phase_id: workspace!.phaseId,
            });
            if (error) throw error;
            return ((data ?? []) as Array<{ transaction_id: number; allocation_amount: number; currency: string | null; fee_charge_id: number | null; allocation_kind: "applied" | "unallocated" | "reversal" }>).map((row) => ({ ...row, amount: row.allocation_amount, scope_kind: "phase" as const }));
          }
          let query = supabase.from("transaction_allocations").select("tenant_id,transaction_id,amount,currency,scope_kind,project_id,phase_id,contract_id,fee_charge_id,allocation_kind").eq("tenant_id", workspace!.tenantId);
          if (isProjectAggregate) query = query.in("scope_kind", ["phase", "project"]).eq("project_id", workspace!.projectId);
          else if (!isCompanyAggregate) query = query.eq("scope_kind", "phase").eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId);
          const { data, error } = await query;
          if (error) throw error;
          return data ?? [];
        },
      },
      {
        queryKey: ["dashboard-sales-leads", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("leads").select("*").eq("tenant_id", workspace!.tenantId);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query.order("updated_at", { ascending: false });
          if (error) throw error;
          return data as Lead[] ?? [];
        },
      },
      {
        queryKey: ["dashboard-follow-ups", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("follow_up_tasks").select("*").eq("tenant_id", workspace!.tenantId)
            .in("status", ["open", "in_progress"]);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query.order("due_at", { ascending: true, nullsFirst: false });
          if (error) throw error;
          return data as FollowUpTask[] ?? [];
        },
      },
      {
        queryKey: ["dashboard-site-visits", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("site_visits").select("*").eq("tenant_id", workspace!.tenantId)
            .in("status", ["scheduled", "rescheduled"]);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query.order("scheduled_at", { ascending: true });
          if (error) throw error;
          return data as SiteVisit[] ?? [];
        },
      },
      {
        queryKey: ["dashboard-lot-reservations", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("lot_reservations").select("*").eq("tenant_id", workspace!.tenantId);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query.order("updated_at", { ascending: false });
          if (error) throw error;
          return data as LotReservation[] ?? [];
        },
      },
      {
        queryKey: ["dashboard-post-sales-tasks", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("post_sales_tasks").select("*").eq("tenant_id", workspace!.tenantId)
            .in("status", ["open", "in_progress", "blocked"]);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query.order("due_at", { ascending: true, nullsFirst: false });
          if (error) throw error;
          return data as PostSalesTask[] ?? [];
        },
      },
      {
        queryKey: ["dashboard-post-sales-checklists", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("post_sales_checklists").select("*").eq("tenant_id", workspace!.tenantId);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query.order("updated_at", { ascending: false });
          if (error) throw error;
          return data as PostSalesChecklist[] ?? [];
        },
      },
      {
        queryKey: ["dashboard-admin-profiles", scopeKey], enabled: Boolean(workspace && canSeeContractBalances),
        queryFn: async () => {
          const { data, error } = await supabase.from("admin_profiles").select("user_id, full_name, email")
            .eq("tenant_id", workspace!.tenantId);
          if (error) throw error;
          return data ?? [];
        },
      },
      {
        queryKey: ["dashboard-payment-requests", scopeKey], enabled: Boolean(workspace && canReadFinancials),
        queryFn: async () => {
          let query = supabase.from("payment_requests").select("*, customers(first_name, last_name)").eq("tenant_id", workspace!.tenantId);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          const { data, error } = await query;
          if (error) throw error;
          return data ?? [];
        },
      },
      {
        queryKey: ["dashboard-map-snapshot", scopeKey], enabled: Boolean(workspace),
        queryFn: async () => {
          let query = supabase.from("map_feature_snapshots").select("outline_count")
            .eq("tenant_id", workspace!.tenantId).eq("is_active", true);
          if (!isCompanyAggregate) {
            query = query.eq("project_id", workspace!.projectId);
            if (!isProjectAggregate) query = query.eq("phase_id", workspace!.phaseId);
          }
          if (isCompanyAggregate || isProjectAggregate) {
            const { data, error } = await query;
            if (error) throw error;
            return (data ?? []).reduce((sum, row) => sum + Number(row.outline_count ?? 0), 0);
          }
          const { data, error } = await query.maybeSingle();
          if (error) throw error;
          return data?.outline_count ?? 0;
        },
      },
      {
        queryKey: ["dashboard-fee-charges", scopeKey, role], enabled: Boolean(workspace && canReadFinancials),
        queryFn: async () => {
          let query = supabase.from("fee_charges").select("id,amount,currency,status,scope_kind,project_id,phase_id").eq("tenant_id", workspace!.tenantId);
          if (isProjectAggregate) query = query.in("scope_kind", ["phase", "project"]).eq("project_id", workspace!.projectId);
          else if (!isCompanyAggregate) query = query.eq("scope_kind", "phase").eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId);
          const { data, error } = await query;
          if (error) throw error;
          return data ?? [];
        },
      },
    ],
  });
  const parcels = results[0].data ?? [];
  const parcelIds = parcels.map((parcel) => parcel.id);
  const balancesQuery = useQuery({
    queryKey: ["dashboard-balances", scopeKey, parcelIds.join(",")],
    enabled: Boolean(workspace && canSeeContractBalances && results[0].isSuccess),
    queryFn: async () => {
      if (!parcelIds.length || !canSeeContractBalances) return [];
      const { data, error } = await supabase.from("contract_financial_summary").select("*").in("parcel_id", parcelIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const isLoading = workspaceLoading || profileLoading || results.some((result) => result.isLoading) || balancesQuery.isLoading;
  const error = results.find((result) => result.error)?.error as Error | undefined;
  const dashboardError = error ?? balancesQuery.error as Error | undefined;
  const applications = results[1].data ?? [];
  const allocations = results[2].data ?? [];
  const scopedAllocations = workspace ? allocations : [];
  const paymentSummary = summarizeAllocationRows(scopedAllocations);
  const feeCharges = results[12].data ?? [];
  const feeSummary = summarizeFeeCharges(feeCharges, scopedAllocations);
  const balances = balancesQuery.data ?? [];
  const leads = results[3].data ?? [];
  const followUps = results[4].data ?? [];
  const siteVisits = results[5].data ?? [];
  const reservations = results[6].data ?? [];
  const postSalesTasks = results[7].data ?? [];
  const postSalesChecklists = results[8].data ?? [];
  const adminProfiles = results[9].data ?? [];
  const paymentRequests = results[10].data ?? [];
  const mapOutlines = results[11].data ?? 0;
  const ownerNames = new Map<string, string>(adminProfiles.map((profile: { user_id: string; full_name?: string | null; email?: string | null }) => [profile.user_id, profile.full_name || profile.email || "Unassigned"]));
  const balanceSummary = summarizeAmountsByCurrency(balances, "remaining_balance");
  const attentionItems = buildOperationalAttention({
    leads,
    followUps,
    reservations,
    applications,
    transactions: [],
    paymentRequests,
    postSalesChecklists,
    postSalesTasks,
    siteVisits,
    ownerNames,
  });
  const attentionGroups = groupOperationalAttention(attentionItems);
  const salesSummary = salesDashboardSummary(leads, followUps, siteVisits, attentionGroups);
  const reservationSummary = reservationDashboardSummary(reservations, attentionGroups);
  const postSalesSummary = postSalesDashboardSummary(postSalesTasks, postSalesChecklists, attentionGroups);
  const pendingApplications = attentionGroups.find((group) => group.kind === "application_review")?.count ?? 0;
  const existingInventory = parcels.filter(isExistingInventoryRecord);
  const rasterDetections = parcels.filter(isRasterDetection);
  const otherProvenanceRecords = parcels.length - existingInventory.length - rasterDetections.length;
  const availableLots = existingInventory.filter(isAvailableForSalesSelection).length;
  const reservedLots = existingInventory.filter((lot) => lot.status === "Reserved").length;
  const soldLots = existingInventory.filter((lot) => lot.status === "Sold").length;
  const collectionAlerts = attentionGroups.find((group) => group.kind === "collection_alert")?.count ?? 0;
  const primaryAttention = attentionGroups[0] ?? null;

  return (
    <div className="space-y-6">
      <DashboardHeader workspaceLabel={workspace ? `${workspace.tenantName} · ${workspace.projectName} · ${workspace.phaseName}` : undefined} />
      {workspace && canAggregateCompanyFinance(role) ? <FinanceScopeControl value={financeScope} onChange={setRequestedFinanceScope} /> : null}
      {isLoading ? <LoadingState /> : null}
      {!workspace && !workspaceLoading ? <ErrorState message={workspaceError ?? "Choose an accessible workspace to view its dashboard."} /> : null}
      {dashboardError ? <ErrorState message={dashboardError.message} /> : null}
      <AttentionBand
        primary={primaryAttention}
        groups={attentionGroups}
        pendingApplications={pendingApplications}
        siteVisitsToday={salesSummary.siteVisitsToday}
        communityDelinquency={collectionAlerts}
      />
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="grid min-w-0 gap-5">
          <SalesMovement salesSummary={salesSummary} />
          <ReservationsReadiness reservationSummary={reservationSummary} />
        </div>
        <AdvisorPanel insights={operationalAttentionInsights(attentionItems)} />
      </section>
      <section className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        {canReadFinancials ? <FinancialSnapshot
          paymentSummary={paymentSummary}
          balanceSummary={canSeeContractBalances ? balanceSummary : []}
          feeSummary={feeSummary}
          scopeLabel={financeScope === "company" ? "Company aggregate" : financeScope === "project" ? "Project aggregate" : "Selected phase"}
          scope={financeScope}
        /> : null}
        <PostSalesWork postSalesSummary={postSalesSummary} />
      </section>
      <SupportingTotals
        existingInventory={existingInventory.length}
        rasterDetections={rasterDetections.length}
        otherProvenanceRecords={otherProvenanceRecords}
        mapOutlines={mapOutlines}
        availableLots={availableLots}
        reservedLots={reservedLots}
        soldLots={soldLots}
        pendingApplications={pendingApplications}
      />
    </div>
  );
}

function DashboardHeader({ workspaceLabel }: { workspaceLabel?: string }) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Daily operations</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-normal text-foreground">Dashboard</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Your daily view of sales, reservations, collections, and work requiring attention.
        </p>
        {workspaceLabel ? <p className="mt-2 text-xs font-medium text-primary">Showing {workspaceLabel}</p> : null}
      </div>
      <div className="rounded-md border border-border bg-card px-3 py-2 text-sm text-slate shadow-sm">
        <span className="font-medium text-foreground">Today</span>
        <span className="mx-2 text-border">|</span>
        {new Intl.DateTimeFormat("en-BZ", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/Belize" }).format(new Date())}
      </div>
    </header>
  );
}

function AttentionBand({
  primary,
  groups,
  pendingApplications,
  siteVisitsToday,
  communityDelinquency,
}: {
  primary: OperationalAttentionGroup | null;
  groups: OperationalAttentionGroup[];
  pendingApplications: number;
  siteVisitsToday: number;
  communityDelinquency: number;
}) {
  const supporting = [
    { title: "Site visits today", value: siteVisitsToday, detail: "Scheduled or rescheduled", icon: CalendarDays, tone: siteVisitsToday > 0 ? "warning" as const : "calm" as const, route: groups.find((group) => group.kind === "site_visit_today")?.viewAllRoute ?? "/leads?focus=site-visits" },
    { title: "Applications waiting", value: pendingApplications, detail: "Pending review", icon: ClipboardCheck, tone: pendingApplications > 0 ? "warning" as const : "calm" as const, route: groups.find((group) => group.kind === "application_review")?.viewAllRoute ?? "/applications?status=Pending%20Review" },
    { title: "Collections alerts", value: communityDelinquency, detail: "Community follow-up", icon: HandCoins, tone: communityDelinquency > 0 ? "warning" as const : "calm" as const, route: groups.find((group) => group.kind === "collection_alert")?.viewAllRoute ?? "/collections?focus=alerts" },
  ];
  const primaryItems = primary?.items.slice(0, 3) ?? [];

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-primary p-5 text-white shadow-[0_14px_32px_rgba(31,41,51,0.14)] sm:p-6">
        <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(135deg,rgba(255,255,255,.16)_1px,transparent_1px),linear-gradient(45deg,rgba(214,168,79,.18)_1px,transparent_1px)] [background-size:28px_28px]" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white/80">
              <AlertTriangle className="h-3.5 w-3.5" />
              Today's Attention
            </div>
            <h2 className="mt-5 max-w-2xl text-2xl font-semibold leading-tight sm:text-4xl">
              {primary ? primary.label : "No major priority flags"}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-white/78">
              {primary
                ? `${primary.count} record${primary.count === 1 ? "" : "s"} need review. Open the source record below before moving into routine dashboard checks.`
                : "Current dashboard rules are not showing overdue or expiring operational work."}
            </p>
          </div>
          <div className="rounded-lg border border-white/15 bg-white/10 p-4 text-right backdrop-blur-0">
            <p className="text-5xl font-semibold tabular-nums sm:text-6xl">{primary?.count ?? 0}</p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft">needs review</p>
          </div>
        </div>
        <div className="relative mt-5 grid gap-2.5">
          {primaryItems.length ? primaryItems.map((item) => <AttentionRecord key={item.id} item={item} />) : <p className="rounded-lg border border-white/15 bg-white/10 p-3 text-sm text-white/80">No source records require attention.</p>}
          {primary ? <Link className="mt-1 inline-flex w-fit rounded-md border border-white/20 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10" to={primary.viewAllRoute}>View all {primary.label.toLowerCase()}</Link> : null}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
        {supporting.map((item) => (
          <SupportingAttention key={item.title} item={item} />
        ))}
      </div>
    </section>
  );
}

function AttentionRecord({ item }: { item: OperationalAttentionItem }) {
  return (
    <div className="rounded-lg border border-white/15 bg-white/10 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-white">{item.title}</p>
          <p className="mt-1 break-words text-xs text-white/80">{item.summary}</p>
          <p className="mt-1 text-xs text-white/70">Owner: {item.ownerName} · Status: {item.currentStatus}</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", item.severity === "critical" ? "bg-danger/90 text-white" : item.severity === "warning" ? "bg-accent text-foreground" : "bg-white/15 text-white")}>
          {item.dueAt ? formatDate(item.dueAt) : "Needs review"}
        </span>
      </div>
      <Link className="mt-2 inline-flex text-xs font-semibold text-accent-soft underline-offset-2 hover:underline" to={item.route}>Open action</Link>
    </div>
  );
}

function SupportingAttention({ item }: { item: { title: string; value: number; detail: string; icon: LucideIcon; tone: "warning" | "calm"; route: string } }) {
  const Icon = item.icon;
  const content = (
    <div className="rounded-xl border border-primary/10 bg-primary-soft p-4 shadow-[var(--shadow-card)] transition hover:border-primary/30">
      <div className="flex items-start justify-between gap-3">
        <div className="rounded-md border border-primary/15 bg-card p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <p className={cn("text-3xl font-semibold tabular-nums", item.tone === "warning" ? "text-warning" : "text-primary")}>{item.value}</p>
      </div>
      <p className="mt-4 font-semibold text-foreground">{item.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
    </div>
  );
  return item.value > 0 ? <Link to={item.route}>{content}</Link> : content;
}

function SalesMovement({ salesSummary }: { salesSummary: ReturnType<typeof salesDashboardSummary> }) {
  return (
    <WorkflowPanel
      title="Sales Movement"
      description="Buyer activity moving through follow-ups, site visits, and sales stages."
      icon={UserRoundCheck}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(280px,0.55fr)]">
        <div className="grid gap-3 sm:grid-cols-2">
          <WorkflowMetric title="Open follow-ups" value={salesSummary.openFollowUps} detail={`${salesSummary.overdueFollowUps} overdue, ${salesSummary.dueTodayFollowUps} due today`} tone={salesSummary.overdueFollowUps > 0 ? "danger" : "info"} href="/leads?focus=followups" />
          <WorkflowMetric title="Upcoming visits" value={salesSummary.upcomingVisits} detail={salesSummary.nextVisit ? `Next ${formatDate(salesSummary.nextVisit.scheduled_at)}` : "No scheduled visits"} tone="info" href="/leads?focus=site-visits" />
          <WorkflowMetric title="Deposit pending" value={salesSummary.depositPending} detail="Lead stage only" tone="warning" href="/leads?focus=reservations" />
          <WorkflowMetric title="Family decision" value={salesSummary.familyDecision} detail="Needs buyer support" tone="warning" href="/leads?stage=family_decision" />
        </div>
        <div className="rounded-lg border border-primary/10 bg-card/80 p-3">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Leads by stage</p>
          <div className="grid gap-2">
            {salesSummary.stageCounts.length ? salesSummary.stageCounts.slice(0, 6).map(([stage, count]) => (
              <StageRow key={stage} label={leadStageLabel(stage)} count={count} tone={leadStageTone(stage)} />
            )) : <p className="text-sm text-muted-foreground">No leads recorded yet.</p>}
          </div>
        </div>
      </div>
    </WorkflowPanel>
  );
}

function ReservationsReadiness({ reservationSummary }: { reservationSummary: ReturnType<typeof reservationDashboardSummary> }) {
  const steps = [
    { title: "Active holds", value: reservationSummary.activeReservations, detail: "Reservation records", tone: "info" as const, route: "/leads?focus=reservations" },
    { title: "Expiring soon", value: reservationSummary.expiringSoon, detail: "Next 3 days", tone: reservationSummary.expiringSoon > 0 ? "warning" as const : "info" as const, route: "/leads?focus=reservations" },
    { title: "Deposit pending", value: reservationSummary.depositPending, detail: `${reservationSummary.depositOverdue} overdue`, tone: reservationSummary.depositOverdue > 0 ? "danger" as const : "warning" as const, route: "/leads?focus=reservations" },
    { title: "Ready next step", value: reservationSummary.depositConfirmed, detail: "Deposit readiness confirmed", tone: "success" as const, route: "/leads?focus=reservations" },
  ];

  return (
    <WorkflowPanel
      title="Reservations / Deposit Readiness"
      description="Internal lot holds and CRM readiness tracking. Confirmed payments remain in the financial ledger."
      icon={MapPinned}
    >
      <div className="grid gap-3 lg:grid-cols-4">
        {steps.map((step, index) => (
          <Link key={step.title} to={step.value > 0 ? step.route : "/leads?focus=reservations"} className="relative rounded-lg border border-primary/10 bg-card/85 p-4 transition hover:border-primary/30">
            {index < steps.length - 1 ? <div className="absolute right-[-14px] top-1/2 hidden h-px w-7 bg-primary/20 lg:block" /> : null}
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{step.title}</p>
            <div className="mt-4 flex items-end justify-between gap-3">
              <p className="text-3xl font-semibold tabular-nums text-primary">{step.value}</p>
              <Badge tone={step.tone === "danger" ? "red" : step.tone === "warning" ? "amber" : step.tone === "success" ? "green" : "blue"}>{step.tone === "success" ? "Ready" : "Track"}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{step.detail}</p>
          </Link>
        ))}
      </div>
    </WorkflowPanel>
  );
}

function FinanceScopeControl({ value, onChange }: { value: "phase" | "project" | "company"; onChange: (value: "phase" | "project" | "company") => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/80 p-3" aria-label="Financial reporting scope">
      <div><p className="text-sm font-medium text-foreground">Reporting scope</p><p className="text-xs text-muted-foreground">Company totals are an explicit Admin/Super Admin view.</p></div>
      <div className="flex gap-2">
        <button type="button" aria-pressed={value === "phase"} className={cn("rounded-lg border px-3 py-2 text-sm", value === "phase" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground")} onClick={() => onChange("phase")}>Selected phase</button>
        <button type="button" aria-pressed={value === "project"} className={cn("rounded-lg border px-3 py-2 text-sm", value === "project" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground")} onClick={() => onChange("project")}>Project aggregate</button>
        <button type="button" aria-pressed={value === "company"} className={cn("rounded-lg border px-3 py-2 text-sm", value === "company" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground")} onClick={() => onChange("company")}>Company aggregate</button>
      </div>
    </div>
  );
}

function FinancialSnapshot({ paymentSummary, balanceSummary, feeSummary, scopeLabel, scope }: {
  paymentSummary: ReturnType<typeof summarizeAllocationRows>;
  balanceSummary: ReturnType<typeof summarizeAmountsByCurrency>;
  feeSummary: ReturnType<typeof summarizeFeeCharges>;
  scopeLabel: string;
  scope: "phase" | "project" | "company";
}) {
  return (
    <section className="rounded-xl border border-[#d9d1c4] bg-card shadow-[0_4px_10px_rgba(31,41,51,0.04)]">
      <div className="flex items-start justify-between gap-4 border-b border-[#e5ded2] px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-secondary" />
            <h2 className="text-lg font-semibold text-foreground">Collections / Financial Snapshot</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{scopeLabel}. Receipt allocations are counted once per allocation; currencies remain separate.</p>
        </div>
        <Badge tone="brown">Ledger</Badge>
      </div>
      <div className="grid divide-y divide-[#e5ded2]">
        {paymentSummary.currencies.map((row) => {
          const allocated = scope === "company" ? row.phase + row.project + row.company : scope === "project" ? row.phase + row.project : row.phase;
          return allocated !== 0 ? <LedgerRow key={`cash-${row.currency ?? "unknown"}`} label={`Allocated cash · ${row.currency ?? "currency unverified"}`} value={formatCurrencyAmount(allocated, row.currency)} detail={`${paymentSummary.receiptCount} unique receipts; ${paymentSummary.allocationCount} allocation rows`} icon={CircleDollarSign} /> : null;
        })}
        {scope === "company" ? paymentSummary.currencies.filter((row) => row.unallocated !== 0).map((row) => <LedgerRow key={`unallocated-${row.currency ?? "unknown"}`} label={`Unallocated cash · ${row.currency ?? "currency unverified"}`} value={formatCurrencyAmount(row.unallocated, row.currency)} detail="Legacy or explicitly unallocated; not assigned to a phase" icon={CircleDollarSign} />) : null}
        {balanceSummary.map((row) => <LedgerRow key={`balance-${row.currency ?? "unknown"}`} label={`Open land balance · ${row.currency ?? "currency unverified"}`} value={formatCurrencyAmount(row.amount, row.currency)} detail="Active contracts in this report scope" icon={Banknote} />)}
        {feeSummary.map((row) => <LedgerRow key={`fee-${row.currency ?? "unknown"}`} label={`Open assessed fees · ${row.currency ?? "currency unverified"}`} value={formatCurrencyAmount(row.outstanding, row.currency)} detail={`Assessed ${formatCurrencyAmount(row.assessed, row.currency)}; collected ${formatCurrencyAmount(row.collected, row.currency)}`} icon={HandCoins} />)}
      </div>
    </section>
  );
}

function PostSalesWork({ postSalesSummary }: { postSalesSummary: ReturnType<typeof postSalesDashboardSummary> }) {
  const urgent = postSalesSummary.blockedCustomers + postSalesSummary.overdueTasks;
  return (
    <WorkflowPanel
      title="Post-Sales Work"
      description="Documents, agreements, payment setup, and handoff work after sales movement."
      icon={ListChecks}
      emphasis={urgent > 0 ? "warning" : "default"}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <WorkflowMetric title="Blocked / overdue" value={urgent} detail={`${postSalesSummary.blockedCustomers} blocked, ${postSalesSummary.overdueTasks} overdue`} tone={urgent > 0 ? "danger" : "success"} />
        <WorkflowMetric title="Open tasks" value={postSalesSummary.openTasks} detail="Active post-sales work" tone={postSalesSummary.openTasks > 0 ? "info" : "success"} />
        <WorkflowMetric title="Documents pending" value={postSalesSummary.documentsPending} detail="Missing or pending review" tone={postSalesSummary.documentsPending > 0 ? "warning" : "success"} />
        <WorkflowMetric title="Agreements ready" value={postSalesSummary.agreementsReady} detail="Review or signature" tone={postSalesSummary.agreementsReady > 0 ? "warning" : "info"} />
        <WorkflowMetric title="Handoff ready" value={postSalesSummary.handoffReady} detail="Ready for collections" tone={postSalesSummary.handoffReady > 0 ? "warning" : "info"} />
        <WorkflowMetric title="Payment setup" value={postSalesSummary.paymentSetupPending} detail="Pending details" tone={postSalesSummary.paymentSetupPending > 0 ? "warning" : "success"} />
      </div>
    </WorkflowPanel>
  );
}

function AdvisorPanel({ insights }: { insights: ReturnType<typeof operationalAttentionInsights> }) {
  return (
    <aside className="rounded-xl border border-accent/30 bg-accent-soft/70 p-5 shadow-[0_6px_18px_rgba(138,90,53,0.07)]">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-md border border-accent/30 bg-card p-2 text-secondary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Staff guidance</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Smart Insights</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">Rule-based guidance from current CRM records.</p>
        </div>
      </div>
      <SmartInsightList insights={insights} compact />
    </aside>
  );
}

function SupportingTotals({
  existingInventory,
  rasterDetections,
  otherProvenanceRecords,
  mapOutlines,
  availableLots,
  reservedLots,
  soldLots,
  pendingApplications,
}: {
  existingInventory: number;
  rasterDetections: number;
  otherProvenanceRecords: number;
  mapOutlines: number;
  availableLots: number;
  reservedLots: number;
  soldLots: number;
  pendingApplications: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/70 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8">
        <SupportingStat title="Existing inventory" value={existingInventory} meta="Manual-provenance parcel records" />
        <SupportingStat title="Raster detections" value={rasterDetections} meta="Map/review data, not sales inventory" />
        <SupportingStat title="Other provenance" value={otherProvenanceRecords} meta="Parcel records needing classification" />
        <SupportingStat title="Map outlines" value={mapOutlines} meta="Display geometry; not inventory" />
        <SupportingStat title="Available manual records" value={availableLots} meta="Stored status and review flag allow selection" />
        <SupportingStat title="Reserved manual records" value={reservedLots} meta="Existing inventory records" />
        <SupportingStat title="Sold manual records" value={soldLots} meta="Existing inventory records" />
        <SupportingStat title="Applications" value={pendingApplications} meta="Pending review" />
      </div>
    </section>
  );
}

function WorkflowPanel({
  title,
  description,
  icon: Icon,
  children,
  emphasis = "default",
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
  emphasis?: "default" | "warning";
}) {
  return (
    <section className={cn("rounded-xl border p-5 shadow-[var(--shadow-card)]", emphasis === "warning" ? "border-warning/25 bg-accent-soft/40" : "border-primary/10 bg-primary-soft/70")}>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-md border border-primary/15 bg-card p-2 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function WorkflowMetric({ title, value, detail, tone, href }: { title: string; value: number; detail: string; tone: "danger" | "warning" | "info" | "success"; href?: string }) {
  const content = (
    <div className="rounded-lg border border-primary/10 bg-card/85 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
        <StatusDot tone={tone} />
      </div>
      <p className="mt-4 text-3xl font-semibold tabular-nums text-primary">{value}</p>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
  return href && value > 0 ? <Link to={href}>{content}</Link> : content;
}

function StageRow({ label, count, tone }: { label: string; count: number; tone: "green" | "amber" | "gray" | "blue" }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-2 last:border-0 last:pb-0">
      <span className="min-w-0 truncate text-sm font-medium text-slate">{label}</span>
      <Badge tone={tone}>{count}</Badge>
    </div>
  );
}

function LedgerRow({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return (
    <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <div className="rounded-md border border-[#e5ded2] bg-[#fbfaf7] p-2 text-secondary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-foreground">{label}</p>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
      </div>
      <p className="text-left text-2xl font-semibold tabular-nums text-foreground sm:text-right">{value}</p>
    </div>
  );
}

function SupportingStat({ title, value, meta }: { title: string; value: string | number; meta: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/60 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
    </div>
  );
}

function StatusDot({ tone }: { tone: "danger" | "warning" | "info" | "success" }) {
  return (
    <span
      className={cn(
        "mt-1 h-2.5 w-2.5 rounded-full",
        tone === "danger" && "bg-danger",
        tone === "warning" && "bg-warning",
        tone === "info" && "bg-info",
        tone === "success" && "bg-success",
      )}
    />
  );
}

function postSalesDashboardSummary(tasks: PostSalesTask[], checklists: PostSalesChecklist[], attentionGroups: OperationalAttentionGroup[]) {
  const overdueTasks = attentionGroups.find((group) => group.kind === "post_sales_task_overdue")?.count ?? 0;
  const blockedCustomers = attentionGroups.find((group) => group.kind === "post_sales_blocker")?.count ?? 0;
  return {
    openTasks: tasks.filter((task) => task.status === "open" || task.status === "in_progress" || task.status === "blocked").length,
    overdueTasks,
    blockedCustomers,
    agreementsReady: checklists.filter((checklist) => checklist.agreement_status === "ready_for_review" || checklist.agreement_status === "sent_for_signature").length,
    documentsPending: checklists.filter((checklist) => checklist.document_status === "missing_documents" || checklist.document_status === "pending_review").length,
    documentsPendingReview: checklists.filter((checklist) => checklist.document_status === "pending_review").length,
    handoffReady: checklists.filter((checklist) => checklist.collections_handoff_status === "ready").length,
    paymentSetupPending: checklists.filter((checklist) => checklist.payment_setup_status === "pending").length,
  };
}

function salesDashboardSummary(leads: Lead[], followUps: FollowUpTask[], siteVisits: SiteVisit[], attentionGroups: OperationalAttentionGroup[]) {
  const today = new Date();
  const stageMap = new Map<Lead["pipeline_stage"], number>();
  leads.forEach((lead) => stageMap.set(lead.pipeline_stage, (stageMap.get(lead.pipeline_stage) ?? 0) + 1));
  const overdueFollowUps = attentionGroups.find((group) => group.kind === "overdue_follow_up")?.count ?? 0;
  const dueTodayFollowUps = attentionGroups.find((group) => group.kind === "follow_up_due_today")?.count ?? 0;
  const siteVisitsToday = attentionGroups.find((group) => group.kind === "site_visit_today")?.count ?? 0;
  const upcomingSiteVisits = siteVisits.filter((visit) => ["scheduled", "rescheduled"].includes(visit.status) && (parseDate(visit.scheduled_at)?.getTime() ?? Number.POSITIVE_INFINITY) >= today.getTime());
  const upcomingVisitCount = (attentionGroups.find((group) => group.kind === "site_visit_today")?.count ?? 0) + (attentionGroups.find((group) => group.kind === "site_visit_upcoming")?.count ?? 0);
  return {
    openFollowUps: followUps.length,
    overdueFollowUps,
    dueTodayFollowUps,
    siteVisitsToday,
    upcomingVisits: upcomingVisitCount,
    nextVisit: upcomingSiteVisits[0] ?? null,
    depositPending: leads.filter((lead) => lead.pipeline_stage === "deposit_pending").length,
    familyDecision: leads.filter((lead) => lead.pipeline_stage === "family_decision").length,
    stageCounts: [...stageMap.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function reservationDashboardSummary(reservations: LotReservation[], attentionGroups: OperationalAttentionGroup[]) {
  const activeStatuses = new Set<LotReservation["status"]>(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
  const activeReservations = reservations.filter((reservation) => activeStatuses.has(reservation.status));
  return {
    activeReservations: activeReservations.length,
    expiringSoon: attentionGroups.find((group) => group.kind === "reservation_expiring")?.count ?? 0,
    depositPending: activeReservations.filter((reservation) => reservation.deposit_status === "pending" || reservation.status === "deposit_pending").length,
    depositOverdue: attentionGroups.find((group) => group.kind === "deposit_overdue")?.count ?? 0,
    depositConfirmed: activeReservations.filter((reservation) => reservation.deposit_status === "confirmed" || reservation.status === "deposit_confirmed").length,
  };
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function leadStageLabel(stage: Lead["pipeline_stage"]) {
  const labels: Record<Lead["pipeline_stage"], string> = {
    new_lead: "New Lead",
    contacted: "Contacted",
    interested: "Interested",
    family_decision: "Family Decision",
    payment_plan_review: "Payment Plan Review",
    site_visit_scheduled: "Site Visit Scheduled",
    deposit_pending: "Deposit Pending",
    deposit_paid: "Deposit Paid",
    application_started: "New Application",
    contract_started: "Contract Started",
    closed_won: "Closed/Won",
    lost_inactive: "Lost/Inactive",
  };
  return labels[stage] ?? stage;
}

function leadStageTone(stage: Lead["pipeline_stage"]) {
  if (stage === "closed_won" || stage === "deposit_paid" || stage === "interested") return "green";
  if (stage === "family_decision" || stage === "payment_plan_review" || stage === "deposit_pending") return "amber";
  if (stage === "lost_inactive") return "gray";
  return "blue";
}
