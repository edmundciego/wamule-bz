import { useQueries } from "@tanstack/react-query";
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  FileWarning,
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
import { dashboardOperationsInsights } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { cn, formatDate, money } from "../lib/utils";
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
  const pendingApplications = applications.filter((app) => app.status === "Pending Review").length;
  const availableLots = parcels.filter((lot) => lot.status === "Available").length;
  const reservedLots = parcels.filter((lot) => lot.status === "Reserved").length;
  const soldLots = parcels.filter((lot) => lot.status === "Sold").length;
  const communityDelinquency = balances.filter((row) => Number(row.community_paid) <= 0).length;
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
  const attentionItems: AttentionItem[] = [
    {
      title: "Overdue follow-ups",
      value: salesSummary.overdueFollowUps,
      detail: `${salesSummary.dueTodayFollowUps} due today`,
      tone: salesSummary.overdueFollowUps > 0 ? "danger" : "calm",
      icon: Clock3,
    },
    {
      title: "Reservations expiring",
      value: reservationSummary.expiringSoon,
      detail: "Next 3 days",
      tone: reservationSummary.expiringSoon > 0 ? "warning" : "calm",
      icon: MapPinned,
    },
    {
      title: "Deposit overdue",
      value: reservationSummary.depositOverdue,
      detail: "CRM readiness follow-up",
      tone: reservationSummary.depositOverdue > 0 ? "danger" : "calm",
      icon: AlertTriangle,
    },
    {
      title: "Post-sales blockers",
      value: postSalesSummary.blockedCustomers + postSalesSummary.overdueTasks,
      detail: `${postSalesSummary.blockedCustomers} blocked, ${postSalesSummary.overdueTasks} overdue`,
      tone: postSalesSummary.blockedCustomers + postSalesSummary.overdueTasks > 0 ? "warning" : "calm",
      icon: FileWarning,
    },
  ];
  const primaryAttention = [...attentionItems].sort((a, b) => b.value - a.value)[0] ?? attentionItems[0];

  return (
    <div className="space-y-6">
      <DashboardHeader />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={error.message} /> : null}
      <AttentionBand
        primary={primaryAttention}
        items={attentionItems}
        pendingApplications={pendingApplications}
        siteVisitsToday={salesSummary.siteVisitsToday}
        communityDelinquency={communityDelinquency}
      />
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="grid min-w-0 gap-5">
          <SalesMovement salesSummary={salesSummary} />
          <ReservationsReadiness reservationSummary={reservationSummary} />
        </div>
        <AdvisorPanel insights={operationsInsights} />
      </section>
      <section className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <FinancialSnapshot
          totalRevenue={totalRevenue}
          openLandBalances={overdueBalance}
          communityDelinquency={communityDelinquency}
          recordedPaymentCount={transactions.length}
        />
        <PostSalesWork postSalesSummary={postSalesSummary} />
      </section>
      <SupportingTotals
        totalLots={parcels.length}
        availableLots={availableLots}
        reservedLots={reservedLots}
        soldLots={soldLots}
        pendingApplications={pendingApplications}
      />
    </div>
  );
}

type AttentionTone = "danger" | "warning" | "calm";

type AttentionItem = {
  title: string;
  value: number;
  detail: string;
  tone: AttentionTone;
  icon: LucideIcon;
};

function DashboardHeader() {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Daily operations</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-normal text-foreground">Dashboard</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Your daily view of sales, reservations, collections, and work requiring attention.
        </p>
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
  items,
  pendingApplications,
  siteVisitsToday,
  communityDelinquency,
}: {
  primary: AttentionItem;
  items: AttentionItem[];
  pendingApplications: number;
  siteVisitsToday: number;
  communityDelinquency: number;
}) {
  const supporting = [
    { title: "Site visits today", value: siteVisitsToday, detail: "Scheduled or rescheduled", icon: CalendarDays, tone: "calm" as const },
    { title: "Applications waiting", value: pendingApplications, detail: "Pending review", icon: ClipboardCheck, tone: pendingApplications > 0 ? "warning" as const : "calm" as const },
    { title: "Collections alerts", value: communityDelinquency, detail: "Community follow-up", icon: HandCoins, tone: communityDelinquency > 0 ? "warning" as const : "calm" as const },
  ];
  const PrimaryIcon = primary.icon;

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-primary p-5 text-white shadow-[0_14px_32px_rgba(31,41,51,0.14)] sm:p-6">
        <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(135deg,rgba(255,255,255,.16)_1px,transparent_1px),linear-gradient(45deg,rgba(214,168,79,.18)_1px,transparent_1px)] [background-size:28px_28px]" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white/80">
              <PrimaryIcon className="h-3.5 w-3.5" />
              Today's Attention
            </div>
            <h2 className="mt-5 max-w-2xl text-2xl font-semibold leading-tight sm:text-4xl">
              {primary.value > 0 ? primary.title : "No major priority flags"}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-white/78">
              {primary.value > 0
                ? `${primary.detail}. Review this area first before moving into routine dashboard checks.`
                : "Current dashboard rules are not showing overdue or expiring operational work."}
            </p>
          </div>
          <div className="rounded-lg border border-white/15 bg-white/10 p-4 text-right backdrop-blur-0">
            <p className="text-5xl font-semibold tabular-nums sm:text-6xl">{primary.value}</p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft">needs review</p>
          </div>
        </div>
        <div className="relative mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((item) => (
            <AttentionStatus key={item.title} item={item} />
          ))}
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

function AttentionStatus({ item }: { item: AttentionItem }) {
  const Icon = item.icon;
  return (
    <div className="rounded-lg border border-white/15 bg-white/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <Icon className="h-4 w-4 text-accent-soft" />
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", item.tone === "danger" ? "bg-danger/90 text-white" : item.tone === "warning" ? "bg-accent text-foreground" : "bg-white/15 text-white")}>
          {item.value}
        </span>
      </div>
      <p className="mt-3 text-sm font-semibold text-white">{item.title}</p>
      <p className="mt-1 text-xs leading-5 text-white/70">{item.detail}</p>
    </div>
  );
}

function SupportingAttention({ item }: { item: { title: string; value: number; detail: string; icon: LucideIcon; tone: AttentionTone } }) {
  const Icon = item.icon;
  return (
    <div className="rounded-xl border border-primary/10 bg-primary-soft p-4 shadow-[var(--shadow-card)]">
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
          <WorkflowMetric title="Open follow-ups" value={salesSummary.openFollowUps} detail={`${salesSummary.overdueFollowUps} overdue, ${salesSummary.dueTodayFollowUps} due today`} tone={salesSummary.overdueFollowUps > 0 ? "danger" : "info"} />
          <WorkflowMetric title="Upcoming visits" value={salesSummary.upcomingVisits} detail={salesSummary.nextVisit ? `Next ${formatDate(salesSummary.nextVisit.scheduled_at)}` : "No scheduled visits"} tone="info" />
          <WorkflowMetric title="Deposit pending" value={salesSummary.depositPending} detail="Lead stage only" tone="warning" />
          <WorkflowMetric title="Family decision" value={salesSummary.familyDecision} detail="Needs buyer support" tone="warning" />
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
    { title: "Active holds", value: reservationSummary.activeReservations, detail: "Reservation records", tone: "info" as const },
    { title: "Expiring soon", value: reservationSummary.expiringSoon, detail: "Next 3 days", tone: reservationSummary.expiringSoon > 0 ? "warning" as const : "info" as const },
    { title: "Deposit pending", value: reservationSummary.depositPending, detail: `${reservationSummary.depositOverdue} overdue`, tone: reservationSummary.depositOverdue > 0 ? "danger" as const : "warning" as const },
    { title: "Ready next step", value: reservationSummary.depositConfirmed, detail: "Deposit readiness confirmed", tone: "success" as const },
  ];

  return (
    <WorkflowPanel
      title="Reservations / Deposit Readiness"
      description="Internal lot holds and CRM readiness tracking. Confirmed payments remain in the financial ledger."
      icon={MapPinned}
    >
      <div className="grid gap-3 lg:grid-cols-4">
        {steps.map((step, index) => (
          <div key={step.title} className="relative rounded-lg border border-primary/10 bg-card/85 p-4">
            {index < steps.length - 1 ? <div className="absolute right-[-14px] top-1/2 hidden h-px w-7 bg-primary/20 lg:block" /> : null}
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{step.title}</p>
            <div className="mt-4 flex items-end justify-between gap-3">
              <p className="text-3xl font-semibold tabular-nums text-primary">{step.value}</p>
              <Badge tone={step.tone === "danger" ? "red" : step.tone === "warning" ? "amber" : step.tone === "success" ? "green" : "blue"}>{step.tone === "success" ? "Ready" : "Track"}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{step.detail}</p>
          </div>
        ))}
      </div>
    </WorkflowPanel>
  );
}

function FinancialSnapshot({
  totalRevenue,
  openLandBalances,
  communityDelinquency,
  recordedPaymentCount,
}: {
  totalRevenue: number;
  openLandBalances: number;
  communityDelinquency: number;
  recordedPaymentCount: number;
}) {
  return (
    <section className="rounded-xl border border-[#d9d1c4] bg-card shadow-[0_4px_10px_rgba(31,41,51,0.04)]">
      <div className="flex items-start justify-between gap-4 border-b border-[#e5ded2] px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-secondary" />
            <h2 className="text-lg font-semibold text-foreground">Collections / Financial Snapshot</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Recorded payment and balance facts from current account data.</p>
        </div>
        <Badge tone="brown">Ledger</Badge>
      </div>
      <div className="grid divide-y divide-[#e5ded2]">
        <LedgerRow label="Revenue collected" value={money(totalRevenue)} detail={`${recordedPaymentCount} recorded transactions`} icon={CircleDollarSign} />
        <LedgerRow label="Open land balances" value={money(openLandBalances)} detail="Customer balance view" icon={Banknote} />
        <LedgerRow label="Community delinquency" value={communityDelinquency.toString()} detail="Rows requiring follow-up" icon={HandCoins} />
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

function AdvisorPanel({ insights }: { insights: ReturnType<typeof dashboardOperationsInsights> }) {
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
  totalLots,
  availableLots,
  reservedLots,
  soldLots,
  pendingApplications,
}: {
  totalLots: number;
  availableLots: number;
  reservedLots: number;
  soldLots: number;
  pendingApplications: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/70 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SupportingStat title="Total lots" value={totalLots} meta="Inventory" />
        <SupportingStat title="Available" value={availableLots} meta="Ready for buyers" />
        <SupportingStat title="Reserved" value={reservedLots} meta="Pending next action" />
        <SupportingStat title="Sold" value={soldLots} meta="Closed inventory" />
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

function WorkflowMetric({ title, value, detail, tone }: { title: string; value: number; detail: string; tone: "danger" | "warning" | "info" | "success" }) {
  return (
    <div className="rounded-lg border border-primary/10 bg-card/85 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
        <StatusDot tone={tone} />
      </div>
      <p className="mt-4 text-3xl font-semibold tabular-nums text-primary">{value}</p>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
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
