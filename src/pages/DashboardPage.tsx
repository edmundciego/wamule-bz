import { useQueries } from "@tanstack/react-query";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { SmartInsightsPanel } from "../components/ui/SmartInsightsPanel";
import { ErrorState, LoadingState } from "../components/ui/State";
import { dashboardOperationsInsights } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";
import type { FollowUpTask, Lead, LotReservation, PostSalesChecklist, PostSalesTask, SiteVisit } from "../types/database";

export function DashboardPage() {
  const results = useQueries({
    queries: [
      { queryKey: ["parcels"], queryFn: async () => (await supabase.from("parcels").select("*")).data ?? [] },
      { queryKey: ["applications"], queryFn: async () => (await supabase.from("applications").select("*")).data ?? [] },
      { queryKey: ["transactions"], queryFn: async () => (await supabase.from("transactions").select("*")).data ?? [] },
      { queryKey: ["balances"], queryFn: async () => (await supabase.from("customer_balance_view").select("*")).data ?? [] },
      { queryKey: ["dashboard-sales-leads"], queryFn: async () => (await supabase.from("leads").select("*").order("updated_at", { ascending: false })).data as Lead[] ?? [] },
      { queryKey: ["dashboard-follow-ups"], queryFn: async () => (await supabase.from("follow_up_tasks").select("*").in("status", ["open", "in_progress"]).order("due_at", { ascending: true, nullsFirst: false })).data as FollowUpTask[] ?? [] },
      { queryKey: ["dashboard-site-visits"], queryFn: async () => (await supabase.from("site_visits").select("*").in("status", ["scheduled", "rescheduled"]).order("scheduled_at", { ascending: true })).data as SiteVisit[] ?? [] },
      { queryKey: ["dashboard-lot-reservations"], queryFn: async () => (await supabase.from("lot_reservations").select("*").order("updated_at", { ascending: false })).data as LotReservation[] ?? [] },
      { queryKey: ["dashboard-post-sales-tasks"], queryFn: async () => (await supabase.from("post_sales_tasks").select("*").in("status", ["open", "in_progress", "blocked"]).order("due_at", { ascending: true, nullsFirst: false })).data as PostSalesTask[] ?? [] },
      { queryKey: ["dashboard-post-sales-checklists"], queryFn: async () => (await supabase.from("post_sales_checklists").select("*").order("updated_at", { ascending: false })).data as PostSalesChecklist[] ?? [] },
    ],
  });
  const isLoading = results.some((result) => result.isLoading);
  const error = results.find((result) => result.error)?.error as Error | undefined;
  const parcels = results[0].data ?? [];
  const applications = results[1].data ?? [];
  const transactions = results[2].data ?? [];
  const balances = results[3].data ?? [];
  const leads = results[4].data ?? [];
  const followUps = results[5].data ?? [];
  const siteVisits = results[6].data ?? [];
  const reservations = results[7].data ?? [];
  const postSalesTasks = results[8].data ?? [];
  const postSalesChecklists = results[9].data ?? [];
  const totalRevenue = transactions.reduce((sum, item) => sum + Number(item.amount), 0);
  const overdueBalance = balances.reduce((sum, item) => sum + Number(item.land_balance ?? 0), 0);
  const salesSummary = salesDashboardSummary(leads, followUps, siteVisits);
  const reservationSummary = reservationDashboardSummary(reservations);
  const postSalesSummary = postSalesDashboardSummary(postSalesTasks, postSalesChecklists);
  const operationsInsights = dashboardOperationsInsights({
    overdueFollowUps: salesSummary.overdueFollowUps,
    siteVisitsToday: salesSummary.siteVisitsToday,
    upcomingSiteVisits: salesSummary.upcomingVisits,
    reservationsExpiringSoon: reservationSummary.expiringSoon,
    depositsOverdue: reservationSummary.depositOverdue,
    postSalesTasksOverdue: postSalesSummary.overdueTasks,
    documentsPendingReview: postSalesSummary.documentsPendingReview,
    collectionsHandoffReady: postSalesSummary.handoffReady,
  });

  return (
    <>
      <PageHeader title="Dashboard" description="Daily operating view for lots, applications, payments, and account follow-up." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={error.message} /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Total lots" value={parcels.length} meta="Inventory" />
        <Metric title="Available lots" value={parcels.filter((lot) => lot.status === "Available").length} meta="Ready for buyers" />
        <Metric title="Reserved lots" value={parcels.filter((lot) => lot.status === "Reserved").length} meta="Pending next action" />
        <Metric title="Sold lots" value={parcels.filter((lot) => lot.status === "Sold").length} meta="Closed inventory" />
        <Metric title="Pending applications" value={applications.filter((app) => app.status === "Pending Review").length} meta="Needs review" />
        <Metric title="Revenue collected" value={money(totalRevenue)} meta="Recorded payments" />
        <Metric title="Open land balances" value={money(overdueBalance)} meta="Collections view" />
        <Metric title="Community delinquency" value={balances.filter((row) => Number(row.community_paid) <= 0).length} meta="Follow-up required" />
      </div>
      <div className="mt-6">
        <SmartInsightsPanel
          title="Operations Insights"
          description="Concise rule-based flags from live CRM records."
          insights={operationsInsights}
        />
      </div>
      <div className="mt-6 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader><CardTitle>Sales Pipeline</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SalesMetric title="Open follow-ups" value={salesSummary.openFollowUps} tone={salesSummary.overdueFollowUps > 0 ? "red" : "blue"} meta={`${salesSummary.overdueFollowUps} overdue, ${salesSummary.dueTodayFollowUps} due today`} />
            <SalesMetric title="Upcoming visits" value={salesSummary.upcomingVisits} tone="blue" meta={salesSummary.nextVisit ? `Next ${formatDate(salesSummary.nextVisit.scheduled_at)}` : "No scheduled visits"} />
            <SalesMetric title="Deposit pending" value={salesSummary.depositPending} tone="amber" meta="Sales stage only" />
            <SalesMetric title="Family decision" value={salesSummary.familyDecision} tone="amber" meta="Needs buyer support" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Leads by Stage</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {salesSummary.stageCounts.length ? salesSummary.stageCounts.map(([stage, count]) => (
              <div key={stage} className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
                <span className="font-medium text-primary">{leadStageLabel(stage)}</span>
                <Badge tone={leadStageTone(stage)}>{count}</Badge>
              </div>
            )) : <p className="text-sm text-muted-foreground">No leads recorded yet.</p>}
          </CardContent>
        </Card>
      </div>
      <div className="mt-6">
        <Card>
          <CardHeader><CardTitle>Reservations & Deposit Readiness</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SalesMetric title="Active reservations" value={reservationSummary.activeReservations} tone="blue" meta="Tracked holds only" />
            <SalesMetric title="Expiring soon" value={reservationSummary.expiringSoon} tone={reservationSummary.expiringSoon > 0 ? "amber" : "blue"} meta="Next 3 days" />
            <SalesMetric title="Deposit pending" value={reservationSummary.depositPending} tone="amber" meta={`${reservationSummary.depositOverdue} overdue`} />
            <SalesMetric title="Deposit overdue" value={reservationSummary.depositOverdue} tone={reservationSummary.depositOverdue > 0 ? "red" : "blue"} meta="Needs follow-up" />
            <SalesMetric title="Ready next step" value={reservationSummary.depositConfirmed} tone="blue" meta="Deposit confirmed" />
          </CardContent>
        </Card>
      </div>
      <div className="mt-6">
        <Card>
          <CardHeader><CardTitle>Post-Sales Automation</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <SalesMetric title="Open tasks" value={postSalesSummary.openTasks} tone={postSalesSummary.overdueTasks > 0 ? "amber" : "blue"} meta={`${postSalesSummary.overdueTasks} overdue`} />
            <SalesMetric title="Blocked customers" value={postSalesSummary.blockedCustomers} tone={postSalesSummary.blockedCustomers > 0 ? "red" : "blue"} meta="Checklist blocked" />
            <SalesMetric title="Agreements ready" value={postSalesSummary.agreementsReady} tone="amber" meta="Review or signature" />
            <SalesMetric title="Documents pending" value={postSalesSummary.documentsPending} tone="amber" meta="Missing/review" />
            <SalesMetric title="Handoff ready" value={postSalesSummary.handoffReady} tone="amber" meta="Ready for collections" />
            <SalesMetric title="Payment setup" value={postSalesSummary.paymentSetupPending} tone="amber" meta="Pending details" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Metric({ title, value, meta }: { title: string; value: string | number; meta: string }) {
  return (
    <Card className="transition-shadow hover:shadow-[var(--shadow-card-hover)]">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-display text-3xl font-semibold text-primary">{value}</p>
        <p className="mt-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{meta}</p>
      </CardContent>
    </Card>
  );
}

function SalesMetric({ title, value, meta, tone }: { title: string; value: number; meta: string; tone: "blue" | "amber" | "red" }) {
  return (
    <div className="crm-subpanel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
        <Badge tone={tone}>{value}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{meta}</p>
    </div>
  );
}

function postSalesDashboardSummary(tasks: PostSalesTask[], checklists: PostSalesChecklist[]) {
  const today = startOfToday();
  return {
    openTasks: tasks.filter((task) => task.status === "open" || task.status === "in_progress" || task.status === "blocked").length,
    overdueTasks: tasks.filter((task) => !["completed", "cancelled"].includes(task.status) && isBefore(task.due_at, today)).length,
    blockedCustomers: checklists.filter((checklist) => checklist.status === "blocked").length,
    agreementsReady: checklists.filter((checklist) => checklist.agreement_status === "ready_for_review" || checklist.agreement_status === "sent_for_signature").length,
    documentsPending: checklists.filter((checklist) => checklist.document_status === "missing_documents" || checklist.document_status === "pending_review").length,
    documentsPendingReview: checklists.filter((checklist) => checklist.document_status === "pending_review").length,
    handoffReady: checklists.filter((checklist) => checklist.collections_handoff_status === "ready").length,
    paymentSetupPending: checklists.filter((checklist) => checklist.payment_setup_status === "pending").length,
  };
}

function salesDashboardSummary(leads: Lead[], followUps: FollowUpTask[], siteVisits: SiteVisit[]) {
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const stageMap = new Map<Lead["pipeline_stage"], number>();
  leads.forEach((lead) => stageMap.set(lead.pipeline_stage, (stageMap.get(lead.pipeline_stage) ?? 0) + 1));
  const upcomingSiteVisits = siteVisits.filter((visit) => {
    const scheduledAt = parseDate(visit.scheduled_at);
    return scheduledAt ? scheduledAt >= today : false;
  });
  return {
    openFollowUps: followUps.length,
    overdueFollowUps: followUps.filter((task) => isBefore(task.due_at, today)).length,
    dueTodayFollowUps: followUps.filter((task) => isWithin(task.due_at, today, tomorrow)).length,
    siteVisitsToday: upcomingSiteVisits.filter((visit) => isWithin(visit.scheduled_at, today, tomorrow)).length,
    upcomingVisits: upcomingSiteVisits.length,
    nextVisit: upcomingSiteVisits[0] ?? null,
    depositPending: leads.filter((lead) => lead.pipeline_stage === "deposit_pending").length,
    familyDecision: leads.filter((lead) => lead.pipeline_stage === "family_decision").length,
    stageCounts: [...stageMap.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function reservationDashboardSummary(reservations: LotReservation[]) {
  const today = startOfToday();
  const expiringCutoff = new Date(today);
  expiringCutoff.setDate(today.getDate() + 3);
  const activeStatuses = new Set<LotReservation["status"]>(["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
  const activeReservations = reservations.filter((reservation) => activeStatuses.has(reservation.status));
  return {
    activeReservations: activeReservations.length,
    expiringSoon: activeReservations.filter((reservation) => isWithinInclusive(reservation.expires_at, today, expiringCutoff)).length,
    depositPending: activeReservations.filter((reservation) => reservation.deposit_status === "pending" || reservation.status === "deposit_pending").length,
    depositOverdue: activeReservations.filter((reservation) => reservation.deposit_status === "overdue" || (reservation.deposit_status === "pending" && isBefore(reservation.deposit_due_at, today))).length,
    depositConfirmed: activeReservations.filter((reservation) => reservation.deposit_status === "confirmed" || reservation.status === "deposit_confirmed").length,
  };
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isBefore(value: string | null | undefined, date: Date) {
  const parsed = parseDate(value);
  return parsed ? parsed < date : false;
}

function isWithin(value: string | null | undefined, start: Date, end: Date) {
  const parsed = parseDate(value);
  return parsed ? parsed >= start && parsed < end : false;
}

function isWithinInclusive(value: string | null | undefined, start: Date, end: Date) {
  const parsed = parseDate(value);
  return parsed ? parsed >= start && parsed <= end : false;
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
    application_started: "Application Started",
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
