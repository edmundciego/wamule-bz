import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, ClipboardList, Edit3, Plus, RefreshCw, XCircle } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { SmartInsightList, SmartInsightsPanel } from "../components/ui/SmartInsightsPanel";
import { getSessionAndProfile } from "../lib/data";
import { fetchReservationWorkflowSettings, futureIsoFromDays, reservationWorkflowDefaults } from "../lib/reservationSettings";
import { activeReservationStatuses, leadSmartInsights, reservationReadinessInsights } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { cn, formatDate, money } from "../lib/utils";
import type {
  AdminProfile,
  Application,
  Customer,
  DepositStatus,
  FollowUpTask,
  FollowUpTaskPriority,
  FollowUpTaskStatus,
  Lead,
  LeadAiSummary,
  LeadActivity,
  LeadActivityType,
  LeadPipelineStage,
  LotReservation,
  Parcel,
  ReservationActivity,
  ReservationActivityType,
  ReservationWorkflowSettings,
  ReservationStatus,
  SiteVisit,
  SiteVisitStatus,
} from "../types/database";

const pipelineStages: Array<{ value: LeadPipelineStage; label: string; tone: BadgeTone }> = [
  { value: "new_lead", label: "New Lead", tone: "blue" },
  { value: "contacted", label: "Contacted", tone: "blue" },
  { value: "interested", label: "Interested", tone: "green" },
  { value: "family_decision", label: "Family Decision", tone: "amber" },
  { value: "payment_plan_review", label: "Payment Plan Review", tone: "amber" },
  { value: "site_visit_scheduled", label: "Site Visit Scheduled", tone: "blue" },
  { value: "deposit_pending", label: "Deposit Pending", tone: "amber" },
  { value: "deposit_paid", label: "Deposit Paid", tone: "green" },
  { value: "application_started", label: "New Application", tone: "blue" },
  { value: "contract_started", label: "Contract Started", tone: "blue" },
  { value: "closed_won", label: "Closed/Won", tone: "green" },
  { value: "lost_inactive", label: "Lost/Inactive", tone: "gray" },
];
const taskPriorities: FollowUpTaskPriority[] = ["low", "normal", "high", "urgent"];
const activityTypes: LeadActivityType[] = ["note", "call", "whatsapp", "email", "follow_up"];
const reservationStatuses: ReservationStatus[] = ["draft", "reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed", "converted_to_application", "converted_to_contract", "expired", "cancelled", "released"];
const depositStatuses: DepositStatus[] = ["not_requested", "pending", "proof_submitted", "confirmed", "overdue", "waived", "cancelled"];

type LeadWithRelations = Lead & {
  parcels?: Pick<Parcel, "id" | "lot_number" | "status"> | null;
  applications?: Pick<Application, "id" | "applicant_full_name" | "first_name" | "last_name" | "status"> | null;
  customers?: Pick<Customer, "id" | "first_name" | "last_name"> | null;
};

type ReservationWithRelations = LotReservation & {
  parcels?: Pick<Parcel, "id" | "lot_number" | "status"> | null;
};

type LeadFormValues = {
  full_name: string;
  email: string;
  phone: string;
  whatsapp: string;
  parcel_id: string;
  application_id: string;
  customer_id: string;
  source: string;
  pipeline_stage: LeadPipelineStage;
  buyer_journey_stage: string;
  decision_blocker: string;
  budget_min: string;
  budget_max: string;
  preferred_contact_method: string;
  assigned_to: string;
  next_action: string;
  next_action_due_at: string;
  notes: string;
  lost_reason: string;
};

type ReservationFormValues = {
  reservation_code: string;
  parcel_id: string;
  status: ReservationStatus;
  deposit_status: DepositStatus;
  expected_deposit_amount: string;
  deposit_due_at: string;
  deposit_paid_at: string;
  reserved_at: string;
  expires_at: string;
  assigned_to: string;
  notes: string;
};

export function LeadsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<LeadPipelineStage | "all">("all");
  const [assignedFilter, setAssignedFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState<"all" | "due" | "overdue">("all");
  const [duplicateFilter, setDuplicateFilter] = useState<"all" | "possible">("all");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [editingLead, setEditingLead] = useState<LeadWithRelations | null>(null);
  const [creatingLead, setCreatingLead] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [generatingSummaryId, setGeneratingSummaryId] = useState<string | null>(null);

  const { data: sessionProfile } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const { data: adminProfiles } = useQuery({
    queryKey: ["sales-admin-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("admin_profiles").select("*").order("full_name");
      if (error) throw error;
      return data as AdminProfile[];
    },
  });
  const { data: aiSettings } = useQuery({
    queryKey: ["lead-ai-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_settings")
        .select("is_enabled")
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { is_enabled: boolean } | null;
    },
  });
  const { data: leads, isLoading, error } = useQuery({
    queryKey: ["sales-leads"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("leads")
        .select("*, parcels(id, lot_number, status), applications(id, applicant_full_name, first_name, last_name, status), customers(id, first_name, last_name)")
        .order("updated_at", { ascending: false });
      if (queryError) throw queryError;
      return data as LeadWithRelations[];
    },
  });
  const { data: activities } = useQuery({
    queryKey: ["sales-lead-activities"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("lead_activities").select("*").order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return data as LeadActivity[];
    },
  });
  const { data: tasks } = useQuery({
    queryKey: ["sales-follow-up-tasks"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("follow_up_tasks").select("*").order("due_at", { ascending: true, nullsFirst: false });
      if (queryError) throw queryError;
      return data as FollowUpTask[];
    },
  });
  const { data: visits } = useQuery({
    queryKey: ["sales-site-visits"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("site_visits").select("*").order("scheduled_at", { ascending: true });
      if (queryError) throw queryError;
      return data as SiteVisit[];
    },
  });
  const { data: reservations } = useQuery({
    queryKey: ["sales-lot-reservations"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("lot_reservations")
        .select("*, parcels(id, lot_number, status)")
        .order("updated_at", { ascending: false });
      if (queryError) throw queryError;
      return data as ReservationWithRelations[];
    },
  });
  const { data: reservationActivities } = useQuery({
    queryKey: ["sales-reservation-activities"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("reservation_activities")
        .select("*")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return data as ReservationActivity[];
    },
  });
  const { data: leadAiSummaries } = useQuery({
    queryKey: ["lead-ai-summaries"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("lead_ai_summaries")
        .select("*")
        .order("generated_at", { ascending: false });
      if (queryError) throw queryError;
      return data as LeadAiSummary[];
    },
  });
  const { data: applications } = useQuery({
    queryKey: ["sales-application-options"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("applications").select("id, applicant_full_name, first_name, last_name, phone, email, status").order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return data;
    },
  });
  const { data: customers } = useQuery({
    queryKey: ["sales-customer-options"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("customers").select("id, first_name, last_name, phone, email").order("last_name");
      if (queryError) throw queryError;
      return data;
    },
  });
  const { data: parcels } = useQuery({
    queryKey: ["sales-parcel-options"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("parcels").select("id, lot_number, status").order("lot_number");
      if (queryError) throw queryError;
      return data as Array<Pick<Parcel, "id" | "lot_number" | "status">>;
    },
  });
  const { data: reservationSettings = reservationWorkflowDefaults } = useQuery({
    queryKey: ["reservation-workflow-settings"],
    queryFn: fetchReservationWorkflowSettings,
  });

  const currentRole = sessionProfile?.profile?.role;
  const canWrite = currentRole === "Super Admin" || currentRole === "Admin" || currentRole === "Staff";
  const selectedLead = useMemo(
    () => leads?.find((lead) => lead.id === selectedLeadId) ?? leads?.[0] ?? null,
    [leads, selectedLeadId],
  );
  const now = new Date();
  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (leads ?? []).filter((lead) => {
      const assigned = assignedFilter === "all" || lead.assigned_to === assignedFilter;
      const stage = stageFilter === "all" || lead.pipeline_stage === stageFilter;
      const dueDate = lead.next_action_due_at ? new Date(lead.next_action_due_at) : null;
      const due =
        dueFilter === "all" ||
        (dueFilter === "due" && dueDate && isToday(dueDate)) ||
        (dueFilter === "overdue" && dueDate && dueDate < startOfToday());
      const duplicate = duplicateFilter === "all" || Boolean(lead.possible_duplicate);
      const matchesSearch = !q || `${lead.full_name} ${lead.phone ?? ""} ${lead.email ?? ""} ${lead.source ?? ""} ${lead.duplicate_reason ?? ""}`.toLowerCase().includes(q);
      return assigned && stage && due && duplicate && matchesSearch;
    });
  }, [assignedFilter, dueFilter, duplicateFilter, leads, search, stageFilter]);
  const selectedActivities = activities?.filter((activity) => activity.lead_id === selectedLead?.id) ?? [];
  const selectedTasks = tasks?.filter((task) => task.lead_id === selectedLead?.id) ?? [];
  const selectedVisits = visits?.filter((visit) => visit.lead_id === selectedLead?.id) ?? [];
  const selectedReservations = reservations?.filter((reservation) => selectedLead && sharesLeadContext(reservation, selectedLead)) ?? [];
  const selectedReservationActivities = reservationActivities?.filter((activity) =>
    selectedReservations.some((reservation) => reservation.id === activity.reservation_id),
  ) ?? [];
  const selectedLeadSummary = leadAiSummaries?.find((summary) => summary.lead_id === selectedLead?.id) ?? null;

  function clearNotices() {
    setActionError(null);
    setMessage(null);
  }

  async function refreshSalesData() {
    await queryClient.invalidateQueries({ queryKey: ["sales-leads"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-lead-activities"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-follow-up-tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-site-visits"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-lot-reservations"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-reservation-activities"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-sales-leads"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-follow-ups"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-site-visits"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-lot-reservations"] });
    await queryClient.invalidateQueries({ queryKey: ["lot-board-active-reservations"] });
  }

  async function generateLeadSummary(leadId: string) {
    clearNotices();
    setGeneratingSummaryId(leadId);
    const { data: result, error: functionError } = await supabase.functions.invoke("generate-lead-summary", {
      body: { lead_id: leadId },
    });
    setGeneratingSummaryId(null);
    if (functionError) {
      setActionError(functionError.message);
      return;
    }
    if (result?.error) {
      setActionError(String(result.error));
      return;
    }
    setMessage(String(result?.message ?? "Lead Smart Summary generated."));
    await queryClient.invalidateQueries({ queryKey: ["lead-ai-summaries"] });
  }

  async function saveLead(values: LeadFormValues, lead?: LeadWithRelations) {
    clearNotices();
    const patch = normalizeLeadValues(values);
    try {
      if (!patch.full_name) throw new Error("Lead name is required.");
      if (patch.budget_min !== null && patch.budget_max !== null && patch.budget_max < patch.budget_min) {
        throw new Error("Budget maximum must be greater than or equal to budget minimum.");
      }
      if (lead) {
        const previousStage = lead.pipeline_stage;
        const { error: updateError } = await supabase.from("leads").update(patch).eq("id", lead.id);
        if (updateError) throw updateError;
        if (previousStage !== patch.pipeline_stage) {
          await addActivity(lead.id, "status_change", "Pipeline stage updated", `${stageLabel(previousStage)} to ${stageLabel(patch.pipeline_stage)}`);
        }
        setMessage("Lead updated.");
      } else {
        const { data, error: insertError } = await supabase.from("leads").insert(patch).select("id").single();
        if (insertError) throw insertError;
        await addActivity(data.id, "note", "Lead created", "Sales lead added to the pipeline.");
        setSelectedLeadId(data.id);
        setMessage("Lead created.");
      }
      setCreatingLead(false);
      setEditingLead(null);
      await refreshSalesData();
    } catch (saveError) {
      setActionError((saveError as Error).message);
    }
  }

  async function addActivity(leadId: string, activityType: LeadActivityType, title: string, description?: string) {
    const { error } = await supabase.from("lead_activities").insert({
      lead_id: leadId,
      activity_type: activityType,
      title,
      description: description?.trim() || null,
      metadata: null,
    });
    if (error) console.warn("Reservation activity was not recorded", error);
  }

  async function createTask(values: TaskFormValues) {
    if (!selectedLead) return;
    clearNotices();
    try {
      const title = values.title.trim();
      if (!title) throw new Error("Follow-up title is required.");
      const { error } = await supabase.from("follow_up_tasks").insert({
        lead_id: selectedLead.id,
        application_id: selectedLead.application_id,
        customer_id: selectedLead.customer_id,
        title,
        description: values.description.trim() || null,
        due_at: values.due_at ? new Date(values.due_at).toISOString() : null,
        priority: values.priority,
        status: "open",
        assigned_to: values.assigned_to || selectedLead.assigned_to || null,
      });
      if (error) throw error;
      await addActivity(selectedLead.id, "follow_up", "Follow-up created", title);
      setMessage("Follow-up task created.");
      await refreshSalesData();
    } catch (taskError) {
      setActionError((taskError as Error).message);
    }
  }

  async function updateTaskStatus(task: FollowUpTask, status: FollowUpTaskStatus) {
    clearNotices();
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const completed = status === "completed";
      const { error } = await supabase
        .from("follow_up_tasks")
        .update({
          status,
          completed_at: completed ? new Date().toISOString() : null,
          completed_by: completed ? sessionData.session?.user.id ?? null : null,
        })
        .eq("id", task.id);
      if (error) throw error;
      if (task.lead_id) await addActivity(task.lead_id, "follow_up", `Follow-up marked ${taskStatusLabel(status)}`, task.title);
      setMessage("Follow-up task updated.");
      await refreshSalesData();
    } catch (taskError) {
      setActionError((taskError as Error).message);
    }
  }

  async function createVisit(values: VisitFormValues) {
    if (!selectedLead) return;
    clearNotices();
    try {
      const scheduledAt = new Date(values.scheduled_at);
      if (Number.isNaN(scheduledAt.getTime())) throw new Error("Choose a valid date and time for the site visit.");
      const { error } = await supabase.from("site_visits").insert({
        lead_id: selectedLead.id,
        application_id: selectedLead.application_id,
        customer_id: selectedLead.customer_id,
        parcel_id: selectedLead.parcel_id,
        scheduled_at: scheduledAt.toISOString(),
        visit_type: values.visit_type.trim() || null,
        location: values.location.trim() || null,
        notes: values.notes.trim() || null,
        status: "scheduled",
        assigned_to: values.assigned_to || selectedLead.assigned_to || null,
      });
      if (error) throw error;
      await addActivity(selectedLead.id, "site_visit", "Site visit scheduled", values.scheduled_at);
      setMessage("Site visit scheduled.");
      await refreshSalesData();
    } catch (visitError) {
      setActionError((visitError as Error).message);
    }
  }

  async function updateVisitStatus(visit: SiteVisit, status: SiteVisitStatus) {
    clearNotices();
    try {
      const { error } = await supabase.from("site_visits").update({
        status,
        completed_at: status === "completed" ? new Date().toISOString() : null,
      }).eq("id", visit.id);
      if (error) throw error;
      if (visit.lead_id) await addActivity(visit.lead_id, "site_visit", `Site visit marked ${visitStatusLabel(status)}`, visit.notes ?? undefined);
      setMessage("Site visit updated.");
      await refreshSalesData();
    } catch (visitError) {
      setActionError((visitError as Error).message);
    }
  }

  async function createReservation(values: ReservationFormValues) {
    if (!selectedLead) return;
    clearNotices();
    try {
      const patch = normalizeReservationValues(values);
      if (patch.expected_deposit_amount !== null && patch.expected_deposit_amount < 0) {
        throw new Error("Expected deposit amount cannot be negative.");
      }
      if (reservationSettings.require_expiry_date && !patch.expires_at) {
        throw new Error("Reservation expiry date is required by reservation settings.");
      }
      if (reservationSettings.require_expected_deposit_amount && patch.expected_deposit_amount === null) {
        throw new Error("Expected deposit amount is required by reservation settings.");
      }
      const { data, error } = await supabase
        .from("lot_reservations")
        .insert({
          ...patch,
          lead_id: selectedLead.id,
          application_id: selectedLead.application_id,
          customer_id: selectedLead.customer_id,
          assigned_to: patch.assigned_to || selectedLead.assigned_to,
        })
        .select("id")
        .single();
      if (error) throw error;
      await addReservationActivity(data.id, "reservation_created", "Reservation created", patch.parcel_id ? `Lot reservation created for parcel #${patch.parcel_id}.` : "Reservation created.");
      setMessage("Reservation created.");
      await refreshSalesData();
    } catch (reservationError) {
      setActionError((reservationError as Error).message);
    }
  }

  async function updateReservation(reservation: LotReservation, values: ReservationFormValues) {
    clearNotices();
    try {
      const patch = normalizeReservationValues(values);
      if (patch.expected_deposit_amount !== null && patch.expected_deposit_amount < 0) {
        throw new Error("Expected deposit amount cannot be negative.");
      }
      const { error } = await supabase.from("lot_reservations").update(patch).eq("id", reservation.id);
      if (error) throw error;
      if (reservation.status !== patch.status) {
        await addReservationActivity(reservation.id, "status_change", "Reservation status updated", `${reservationStatusLabel(reservation.status)} to ${reservationStatusLabel(patch.status)}`);
      }
      if (reservation.deposit_status !== patch.deposit_status) {
        await addReservationActivity(reservation.id, "deposit_status_change", "Deposit status updated", `${depositStatusLabel(reservation.deposit_status)} to ${depositStatusLabel(patch.deposit_status)}`);
      }
      if (reservation.expires_at !== patch.expires_at) {
        await addReservationActivity(reservation.id, "expiration_updated", "Reservation expiry updated", patch.expires_at ? formatDate(patch.expires_at) : "No expiry date");
      }
      setMessage("Reservation updated.");
      await refreshSalesData();
    } catch (reservationError) {
      setActionError((reservationError as Error).message);
    }
  }

  async function quickUpdateReservation(reservation: LotReservation, status: ReservationStatus, depositStatus?: DepositStatus) {
    clearNotices();
    try {
      const nowIso = new Date().toISOString();
      const patch = {
        status,
        deposit_status: depositStatus ?? reservation.deposit_status,
        released_at: status === "released" || status === "cancelled" ? nowIso : reservation.released_at,
        deposit_paid_at: (depositStatus ?? reservation.deposit_status) === "confirmed" ? nowIso : reservation.deposit_paid_at,
      };
      const { error } = await supabase.from("lot_reservations").update(patch).eq("id", reservation.id);
      if (error) throw error;
      await addReservationActivity(
        reservation.id,
        status === "released" ? "reservation_released" : "status_change",
        `Reservation marked ${reservationStatusLabel(status)}`,
        depositStatus ? `Deposit status: ${depositStatusLabel(depositStatus)}` : undefined,
      );
      setMessage("Reservation updated.");
      await refreshSalesData();
    } catch (reservationError) {
      setActionError((reservationError as Error).message);
    }
  }

  async function releaseAlternateReservations(primaryReservationId: string, reservationIds: string[], reason: string) {
    clearNotices();
    const releaseReason = reason.trim();
    if (!releaseReason) {
      setActionError("Release reason is required.");
      return false;
    }
    if (reservationIds.length === 0) {
      setActionError("Select at least one alternate reservation to release.");
      return false;
    }

    const { data, error } = await supabase.rpc("release_alternate_reservations", {
      p_primary_reservation_id: primaryReservationId,
      p_reservation_ids: reservationIds,
      p_release_reason: releaseReason,
    });
    if (error) {
      setActionError(error.message);
      return false;
    }

    const result = Array.isArray(data) ? data[0] : null;
    const releasedCount = result?.released_reservation_ids?.length ?? 0;
    setMessage(releasedCount > 0 ? `${releasedCount} alternate reservation${releasedCount === 1 ? "" : "s"} released.` : "No alternate reservations were released.");
    await refreshSalesData();
    return true;
  }

  async function addReservationActivity(reservationId: string, activityType: ReservationActivityType, title: string, description?: string) {
    const { error } = await supabase.from("reservation_activities").insert({
      reservation_id: reservationId,
      activity_type: activityType,
      title,
      description: description?.trim() || null,
      metadata: null,
    });
    if (error) throw error;
  }

  async function createTimelineNote(values: ActivityFormValues) {
    if (!selectedLead) return;
    clearNotices();
    try {
      const title = values.title.trim();
      if (!title) throw new Error("Activity title is required.");
      await addActivity(selectedLead.id, values.activity_type, title, values.description);
      setMessage("Activity added.");
      await refreshSalesData();
    } catch (activityError) {
      setActionError((activityError as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Leads"
        description="Sales pipeline, follow-ups, site visits, and buyer journey tracking."
        action={canWrite ? (
          <Button type="button" onClick={() => { setCreatingLead(true); setEditingLead(null); }}>
            <Plus className="h-4 w-4" />
            New Lead
          </Button>
        ) : null}
      />
      {isLoading ? <LoadingState label="Loading leads" /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {actionError ? <div className="mb-4"><ErrorState message={actionError} /></div> : null}
      {message ? <div className="crm-success-panel mb-4 p-3 text-sm">{message}</div> : null}
      <div className="crm-info-panel mb-4 p-4 text-sm">
        Leads track interested buyers before or during the application and customer process. Follow-ups are internal reminders for the next staff action, and Site Visits are appointments to view a project or lot.
      </div>

      {(creatingLead || editingLead) && canWrite ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{editingLead ? "Edit Lead" : "Create Lead"}</CardTitle>
          </CardHeader>
          <CardContent>
            <LeadForm
              key={editingLead?.id ?? "new-lead"}
              lead={editingLead}
              adminProfiles={adminProfiles ?? []}
              applications={applications ?? []}
              customers={customers ?? []}
              parcels={parcels ?? []}
              onCancel={() => { setCreatingLead(false); setEditingLead(null); }}
              onSubmit={(values) => void saveLead(values, editingLead ?? undefined)}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="grid min-w-0 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Sales Pipeline</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">A Lead is a person who has shown interest in a project or lot but may not yet be an applicant or customer.</p>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-[minmax(220px,1fr)_220px_220px_180px_180px]">
                <Field label="Search">
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, phone, email, source" />
                </Field>
                <Field label="Pipeline stage">
                  <Select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as LeadPipelineStage | "all")}>
                    <option value="all">All stages</option>
                    {pipelineStages.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}
                  </Select>
                </Field>
                <Field label="Assigned staff">
                  <Select value={assignedFilter} onChange={(event) => setAssignedFilter(event.target.value)}>
                    <option value="all">All staff</option>
                    {(adminProfiles ?? []).map((profile) => (
                      <option key={profile.user_id} value={profile.user_id}>{adminLabel(profile)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Follow-up">
                  <Select value={dueFilter} onChange={(event) => setDueFilter(event.target.value as typeof dueFilter)}>
                    <option value="all">All</option>
                    <option value="due">Due today</option>
                    <option value="overdue">Overdue</option>
                  </Select>
                </Field>
                <Field label="Duplicate review">
                  <Select value={duplicateFilter} onChange={(event) => setDuplicateFilter(event.target.value as typeof duplicateFilter)}>
                    <option value="all">All leads</option>
                    <option value="possible">Possible duplicates</option>
                  </Select>
                </Field>
              </div>
              {filteredLeads.length ? (
                <div className="overflow-x-auto">
                  <table className="crm-table min-w-[980px]">
                    <thead>
                      <tr>
                        <th>Lead</th>
                        <th>Stage</th>
                        <th>Next Action</th>
                        <th>Assigned</th>
                        <th>Linked Records</th>
                        <th>Updated</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLeads.map((lead) => (
                        <tr key={lead.id}>
                          <td>
                            <div className="max-w-[260px] break-words font-medium text-foreground">{lead.full_name}</div>
                            <div className="max-w-[260px] break-words text-xs text-muted-foreground">{[lead.phone, lead.email].filter(Boolean).join(" | ") || "No contact details"}</div>
                            {lead.possible_duplicate ? (
                              <div className="mt-1 grid gap-1">
                                <Badge tone="amber">Possible Duplicate</Badge>
                                <div className="max-w-[260px] break-words text-xs text-amber-700">{lead.duplicate_reason ?? "Review matching application or lead records."}</div>
                              </div>
                            ) : null}
                          </td>
                          <td><PipelineBadge stage={lead.pipeline_stage} /></td>
                          <td>
                            <div className="max-w-[240px] truncate">{lead.next_action ?? "No next action"}</div>
                            <div className={cn("text-xs", isOverdue(lead.next_action_due_at, now) ? "text-danger" : "text-muted-foreground")}>
                              {lead.next_action_due_at ? formatDate(lead.next_action_due_at) : "No due date"}
                            </div>
                          </td>
                          <td>{adminLabelById(adminProfiles, lead.assigned_to)}</td>
                          <td>
                            <div className="grid gap-1 text-xs">
                              {lead.applications ? <span>Application #{lead.applications.id}</span> : null}
                              {lead.customers ? <span>Customer #{lead.customers.id}</span> : null}
                              {lead.parcels ? <span>Lot {lead.parcels.lot_number}</span> : null}
                              {!lead.applications && !lead.customers && !lead.parcels ? <span className="text-muted-foreground">Not linked</span> : null}
                            </div>
                          </td>
                          <td>{formatDate(lead.updated_at)}</td>
                          <td>
                            <Button type="button" variant={selectedLead?.id === lead.id ? "primary" : "outline"} onClick={() => setSelectedLeadId(lead.id)}>
                              View
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="No leads found" detail="Create a lead or adjust the sales filters." />
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="grid min-w-0 content-start gap-4">
          {selectedLead ? (
            <>
              <LeadDetailCard
                lead={selectedLead}
                adminProfiles={adminProfiles ?? []}
                tasks={selectedTasks}
                visits={selectedVisits}
                canWrite={canWrite}
                onEdit={() => { setEditingLead(selectedLead); setCreatingLead(false); }}
              />
              <BuyerInsights lead={selectedLead} tasks={selectedTasks} visits={selectedVisits} reservations={selectedReservations} />
              <LeadSmartSummaryPanel
                summary={selectedLeadSummary}
                aiEnabled={Boolean(aiSettings?.is_enabled)}
                canGenerate={canWrite}
                generating={generatingSummaryId === selectedLead.id}
                onGenerate={() => void generateLeadSummary(selectedLead.id)}
              />
              <ReservationsCard
                reservations={selectedReservations}
                tasks={selectedTasks}
                activities={selectedReservationActivities}
                canWrite={canWrite}
                onSave={(reservation, values) => reservation ? void updateReservation(reservation, values) : void createReservation(values)}
                onQuickUpdate={(reservation, status, depositStatus) => void quickUpdateReservation(reservation, status, depositStatus)}
                onReleaseAlternates={(primaryReservationId, reservationIds, reason) => releaseAlternateReservations(primaryReservationId, reservationIds, reason)}
                adminProfiles={adminProfiles ?? []}
                parcels={parcels ?? []}
                lead={selectedLead}
                reservationSettings={reservationSettings}
              />
              {canWrite ? (
                <>
                  <TaskForm key={`task-${selectedLead.id}`} adminProfiles={adminProfiles ?? []} lead={selectedLead} onSubmit={(values) => void createTask(values)} />
                  <VisitForm key={`visit-${selectedLead.id}`} adminProfiles={adminProfiles ?? []} lead={selectedLead} onSubmit={(values) => void createVisit(values)} />
                  <ActivityForm key={`activity-${selectedLead.id}`} onSubmit={(values) => void createTimelineNote(values)} />
                </>
              ) : null}
              <TasksCard tasks={selectedTasks} canWrite={canWrite} onUpdate={updateTaskStatus} />
              <VisitsCard visits={selectedVisits} canWrite={canWrite} onUpdate={updateVisitStatus} />
              <TimelineCard activities={selectedActivities} />
            </>
          ) : (
            <EmptyState title="No lead selected" detail="Select a lead to view buyer details, follow-ups, visits, and timeline notes." />
          )}
        </aside>
      </div>
    </>
  );
}

function LeadForm({
  lead,
  adminProfiles,
  applications,
  customers,
  parcels,
  onSubmit,
  onCancel,
}: {
  lead: LeadWithRelations | null;
  adminProfiles: AdminProfile[];
  applications: Array<Pick<Application, "id" | "applicant_full_name" | "first_name" | "last_name" | "phone" | "email" | "status">>;
  customers: Array<Pick<Customer, "id" | "first_name" | "last_name" | "phone" | "email">>;
  parcels: Array<Pick<Parcel, "id" | "lot_number" | "status">>;
  onSubmit: (values: LeadFormValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<LeadFormValues>(() => leadToFormValues(lead));

  function setField<K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(values);
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Full name">
          <Input value={values.full_name} onChange={(event) => setField("full_name", event.target.value)} required />
        </Field>
        <Field label="Pipeline stage">
          <Select value={values.pipeline_stage} onChange={(event) => setField("pipeline_stage", event.target.value as LeadPipelineStage)}>
            {pipelineStages.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}
          </Select>
        </Field>
        <Field label="Phone">
          <Input value={values.phone} onChange={(event) => setField("phone", event.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={values.email} onChange={(event) => setField("email", event.target.value)} />
        </Field>
        <Field label="WhatsApp">
          <Input value={values.whatsapp} onChange={(event) => setField("whatsapp", event.target.value)} />
        </Field>
        <Field label="Source">
          <Input value={values.source} onChange={(event) => setField("source", event.target.value)} placeholder="Referral, phone, WhatsApp, walk-in" />
        </Field>
        <Field label="Assigned staff">
          <Select value={values.assigned_to} onChange={(event) => setField("assigned_to", event.target.value)}>
            <option value="">Unassigned</option>
            {adminProfiles.map((profile) => <option key={profile.user_id} value={profile.user_id}>{adminLabel(profile)}</option>)}
          </Select>
        </Field>
        <Field label="Interested lot">
          <Select value={values.parcel_id} onChange={(event) => setField("parcel_id", event.target.value)}>
            <option value="">No lot selected</option>
            {parcels.map((parcel) => <option key={parcel.id} value={parcel.id}>Lot {parcel.lot_number} ({parcel.status})</option>)}
          </Select>
        </Field>
        <Field label="Linked application">
          <Select value={values.application_id} onChange={(event) => setField("application_id", event.target.value)}>
            <option value="">No application</option>
            {applications.map((application) => (
              <option key={application.id} value={application.id}>
                #{application.id} - {applicationName(application)} ({application.status})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Linked customer">
          <Select value={values.customer_id} onChange={(event) => setField("customer_id", event.target.value)}>
            <option value="">No customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                #{customer.id} - {customer.first_name} {customer.last_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Buyer journey">
          <Input value={values.buyer_journey_stage} onChange={(event) => setField("buyer_journey_stage", event.target.value)} placeholder="Researching, ready, waiting on family" />
        </Field>
        <Field label="Decision blocker">
          <Input value={values.decision_blocker} onChange={(event) => setField("decision_blocker", event.target.value)} />
        </Field>
        <Field label="Budget minimum">
          <Input type="number" min="0" step="0.01" value={values.budget_min} onChange={(event) => setField("budget_min", event.target.value)} />
        </Field>
        <Field label="Budget maximum">
          <Input type="number" min="0" step="0.01" value={values.budget_max} onChange={(event) => setField("budget_max", event.target.value)} />
        </Field>
        <Field label="Preferred contact method">
          <Input value={values.preferred_contact_method} onChange={(event) => setField("preferred_contact_method", event.target.value)} placeholder="Phone, WhatsApp, email" />
        </Field>
        <Field label="Next action due">
          <Input type="datetime-local" value={values.next_action_due_at} onChange={(event) => setField("next_action_due_at", event.target.value)} />
        </Field>
      </div>
      <Field label="Next action">
        <Input value={values.next_action} onChange={(event) => setField("next_action", event.target.value)} />
      </Field>
      <Field label="Notes">
        <Textarea value={values.notes} onChange={(event) => setField("notes", event.target.value)} />
      </Field>
      {values.pipeline_stage === "lost_inactive" ? (
        <Field label="Lost / inactive reason">
          <Textarea value={values.lost_reason} onChange={(event) => setField("lost_reason", event.target.value)} />
        </Field>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{lead ? "Save Lead" : "Create Lead"}</Button>
      </div>
    </form>
  );
}

function LeadDetailCard({
  lead,
  adminProfiles,
  tasks,
  visits,
  canWrite,
  onEdit,
}: {
  lead: LeadWithRelations;
  adminProfiles: AdminProfile[];
  tasks: FollowUpTask[];
  visits: SiteVisit[];
  canWrite: boolean;
  onEdit: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="break-words">{lead.full_name}</CardTitle>
          <p className="mt-1 break-words text-sm text-muted-foreground">{[lead.phone, lead.email, lead.whatsapp ? `WhatsApp ${lead.whatsapp}` : ""].filter(Boolean).join(" | ") || "No contact details"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {lead.possible_duplicate ? <Badge tone="amber">Possible Duplicate</Badge> : null}
          <PipelineBadge stage={lead.pipeline_stage} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 text-sm">
          <Meta label="Assigned staff" value={adminLabelById(adminProfiles, lead.assigned_to)} />
          <Meta label="Next action" value={lead.next_action ?? "No next action recorded"} />
          <Meta label="Next action due" value={lead.next_action_due_at ? formatDate(lead.next_action_due_at) : "No due date"} />
          <Meta label="Buyer journey" value={lead.buyer_journey_stage ?? "Not recorded"} />
          <Meta label="Decision blocker" value={lead.decision_blocker ?? "No blocker recorded"} />
          <Meta label="Budget" value={budgetLabel(lead)} />
          <Meta label="Preferred contact" value={lead.preferred_contact_method ?? "Not recorded"} />
          <Meta label="Source" value={lead.source ?? "Not recorded"} />
          {lead.possible_duplicate ? (
            <Meta label="Duplicate review" value={lead.duplicate_reason ?? "Review matching application or lead records."} />
          ) : null}
        </div>
        <div className="grid gap-2 text-sm">
          {lead.parcels ? <p>Interested lot: <strong>Lot {lead.parcels.lot_number}</strong></p> : null}
          {lead.applications ? <p>Application: <strong>#{lead.applications.id} - {applicationName(lead.applications)}</strong></p> : null}
          {lead.customers ? (
            <p>Customer: <Link className="font-semibold text-primary hover:text-primary-hover" to={`/customers/${lead.customers.id}`}>#{lead.customers.id} - {lead.customers.first_name} {lead.customers.last_name}</Link></p>
          ) : null}
          <p className="text-muted-foreground">{tasks.filter((task) => task.status === "open" || task.status === "in_progress").length} open follow-ups, {visits.filter((visit) => visit.status === "scheduled" || visit.status === "rescheduled").length} upcoming visits.</p>
        </div>
        {lead.notes ? <div className="crm-subpanel break-words text-sm text-muted-foreground">{lead.notes}</div> : null}
        {canWrite ? (
          <Button type="button" variant="outline" onClick={onEdit}>
            <Edit3 className="h-4 w-4" />
            Edit Lead
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BuyerInsights({ lead, tasks, visits, reservations }: { lead: LeadWithRelations; tasks: FollowUpTask[]; visits: SiteVisit[]; reservations: LotReservation[] }) {
  return (
    <SmartInsightsPanel
      title="Buyer Insights"
      description="Rule-based guidance from lead, follow-up, visit, and reservation records."
      insights={leadSmartInsights(lead, tasks, visits, reservations)}
    />
  );
}

function LeadSmartSummaryPanel({
  summary,
  aiEnabled,
  canGenerate,
  generating,
  onGenerate,
}: {
  summary: LeadAiSummary | null;
  aiEnabled: boolean;
  canGenerate: boolean;
  generating: boolean;
  onGenerate: () => void;
}) {
  const risks = stringList(summary?.key_risks);
  const missing = stringList(summary?.missing_information);
  const actions = stringList(summary?.recommended_actions);
  const summaryText = safeString(summary?.summary, "No summary text recorded.");

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Lead Smart Summary</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            This summary is generated from Wamule CRM data to support staff review. Staff should verify details before making decisions.
          </p>
        </div>
        {summary?.readiness_status ? <Badge tone={readinessTone(summary.readiness_status)}>{readinessLabel(summary.readiness_status)}</Badge> : <Badge tone="gray">Not generated</Badge>}
      </CardHeader>
      <CardContent className="grid gap-4">
        {summary ? (
          <>
            <div className="crm-info-panel break-words p-3 text-sm leading-6">
              {summaryText}
            </div>
            <SummaryList title="Risk Flags" items={risks} empty="No risk flags listed." tone="red" />
            <SummaryList title="Missing Information" items={missing} empty="No missing information listed." tone="amber" />
            <SummaryList title="Recommended Actions" items={actions} empty="No recommended actions listed." tone="blue" />
            {summary.next_best_action ? (
              <div className="crm-subpanel text-sm">
                <p className="font-semibold text-primary">Next Best Action</p>
                <p className="mt-1 break-words text-muted-foreground">{summary.next_best_action}</p>
              </div>
            ) : null}
            {summary.confidence_notes ? (
              <div className="crm-subpanel text-sm">
                <p className="font-semibold text-primary">Confidence Notes</p>
                <p className="mt-1 break-words text-muted-foreground">{summary.confidence_notes}</p>
              </div>
            ) : null}
            <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <span className="break-words">Generated: {safeFormatDate(summary.generated_at)}</span>
              <span className="break-words">Provider: {safeString(summary.provider, "Not recorded")}</span>
              <span className="break-words">Model: {safeString(summary.model, "Not recorded")}</span>
            </div>
          </>
        ) : (
          <div className="crm-subpanel text-sm text-muted-foreground">
            No Lead Smart Summary has been generated for this buyer yet. Rule-based Buyer Insights remain available above.
          </div>
        )}
        {!aiEnabled ? (
          <div className="crm-warning-panel p-3 text-sm">
            AI provider access is disabled. Staff can still generate a deterministic fallback summary from current CRM data.
          </div>
        ) : null}
        {canGenerate ? (
          <Button type="button" variant={summary ? "outline" : "primary"} disabled={generating} onClick={onGenerate}>
            <RefreshCw className={cn("h-4 w-4", generating && "animate-spin")} />
            {generating ? "Generating..." : summary ? "Regenerate Summary" : "Generate Summary"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">You can view summaries but do not have permission to generate them.</p>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: BadgeTone }) {
  return (
    <div className="grid gap-2 text-sm">
      <p className="font-semibold text-primary">{title}</p>
      {items.length ? items.map((item) => (
        <div key={item} className="flex items-start gap-2 rounded-md border border-border bg-card p-2 shadow-sm shadow-primary/5">
          <Badge tone={tone}>{title === "Recommended Actions" ? "Action" : "Note"}</Badge>
          <span className="min-w-0 break-words text-muted-foreground">{item}</span>
        </div>
      )) : <p className="text-muted-foreground">{empty}</p>}
    </div>
  );
}

function ReservationsCard({
  reservations,
  tasks,
  activities,
  canWrite,
  onSave,
  onQuickUpdate,
  onReleaseAlternates,
  adminProfiles,
  parcels,
  lead,
  reservationSettings,
}: {
  reservations: ReservationWithRelations[];
  tasks: FollowUpTask[];
  activities: ReservationActivity[];
  canWrite: boolean;
  onSave: (reservation: ReservationWithRelations | null, values: ReservationFormValues) => void;
  onQuickUpdate: (reservation: ReservationWithRelations, status: ReservationStatus, depositStatus?: DepositStatus) => void;
  onReleaseAlternates: (primaryReservationId: string, reservationIds: string[], reason: string) => Promise<boolean>;
  adminProfiles: AdminProfile[];
  parcels: Array<Pick<Parcel, "id" | "lot_number" | "status">>;
  lead: LeadWithRelations;
  reservationSettings: ReservationWorkflowSettings;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [releasePrimaryId, setReleasePrimaryId] = useState<string | null>(null);
  const [releaseSelectedIds, setReleaseSelectedIds] = useState<string[]>([]);
  const [releaseReason, setReleaseReason] = useState("");
  const [releaseSubmitting, setReleaseSubmitting] = useState(false);
  const activeReservation = reservations.find((reservation) => activeReservationStatuses.has(reservation.status)) ?? null;
  const editingReservation = reservations.find((reservation) => reservation.id === editingId) ?? null;
  const releasePrimary = reservations.find((reservation) => reservation.id === releasePrimaryId) ?? null;
  const releaseAlternates = releasePrimary ? alternateReservationsForPrimary(releasePrimary, reservations) : [];

  function openReleaseAlternates(reservation: ReservationWithRelations) {
    const alternates = alternateReservationsForPrimary(reservation, reservations);
    setReleasePrimaryId(reservation.id);
    setReleaseSelectedIds(alternates.map((alternate) => alternate.id));
    setReleaseReason("");
  }

  function toggleReleaseSelection(reservationId: string) {
    setReleaseSelectedIds((current) =>
      current.includes(reservationId)
        ? current.filter((id) => id !== reservationId)
        : [...current, reservationId],
    );
  }

  async function submitReleaseAlternates() {
    if (!releasePrimary) return;
    setReleaseSubmitting(true);
    const success = await onReleaseAlternates(releasePrimary.id, releaseSelectedIds, releaseReason);
    setReleaseSubmitting(false);
    if (!success) return;
    setReleasePrimaryId(null);
    setReleaseSelectedIds([]);
    setReleaseReason("");
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Reservations</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {reservationSettings.show_reservation_explanations
              ? "Reservations are internal lot holds or buyer-interest records. They help the team track serious interest in a specific lot while deposit, application, or contract next steps are handled."
              : "Internal lot holds and buyer-interest records."}
          </p>
        </div>
        {activeReservation ? <ReservationBadge status={activeReservation.status} /> : <Badge tone="gray">No active hold</Badge>}
      </CardHeader>
      <CardContent className="grid gap-4">
        {canWrite && !activeReservation && !editingReservation ? (
          <ReservationForm
            key={`new-reservation-${lead.id}`}
            lead={lead}
            reservation={null}
            adminProfiles={adminProfiles}
            parcels={parcels}
            reservationSettings={reservationSettings}
            onSubmit={(values) => onSave(null, values)}
          />
        ) : null}
        {reservations.length === 0 ? <p className="text-sm text-muted-foreground">No reservations recorded for this lead.</p> : null}
        {reservations.map((reservation) => (
          <div key={reservation.id} className="grid gap-3 rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-medium text-primary">
                  {reservation.reservation_code || "Reservation"} {reservation.parcels?.lot_number ? `- Lot ${reservation.parcels.lot_number}` : ""}
                </p>
                <p className="text-muted-foreground">
                  Deposit {reservation.expected_deposit_amount ? money(reservation.expected_deposit_amount) : "not set"} | Due {reservation.deposit_due_at ? formatDate(reservation.deposit_due_at) : "not set"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <ReservationBadge status={reservation.status} />
                <DepositBadge status={reservation.deposit_status} />
              </div>
            </div>
            <div className="grid gap-2 text-muted-foreground sm:grid-cols-2">
              <span>Reserved: {reservation.reserved_at ? formatDate(reservation.reserved_at) : "Not set"}</span>
              <span>Expires: {reservation.expires_at ? formatDate(reservation.expires_at) : "No expiry"}</span>
              <span>Deposit paid: {reservation.deposit_paid_at ? formatDate(reservation.deposit_paid_at) : "Not confirmed"}</span>
              {reservation.status === "released" ? (
                <span>Released: {reservation.released_at ? formatDate(reservation.released_at) : "Date not recorded"}</span>
              ) : null}
              <span>Assigned: {adminLabelById(adminProfiles, reservation.assigned_to)}</span>
            </div>
            {reservation.notes ? <p className="break-words text-muted-foreground">{reservation.notes}</p> : null}
            <ReservationReleasePrompt reservation={reservation} reservations={reservations} lead={lead} settings={reservationSettings} />
            <ReservationInsights reservation={reservation} tasks={tasks} />
            {canWrite ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="h-9" onClick={() => setEditingId(editingId === reservation.id ? null : reservation.id)}>
                  {editingId === reservation.id ? "Close Edit" : "Edit"}
                </Button>
                {activeReservationStatuses.has(reservation.status) && reservation.deposit_status !== "confirmed" ? (
                  <Button type="button" variant="outline" className="h-9" onClick={() => onQuickUpdate(reservation, "deposit_confirmed", "confirmed")}>
                    Confirm Deposit
                  </Button>
                ) : null}
                {activeReservationStatuses.has(reservation.status) ? (
                  <>
                    {alternateReservationsForPrimary(reservation, reservations).length > 0 ? (
                      <Button type="button" variant="outline" className="h-9" onClick={() => openReleaseAlternates(reservation)}>
                        Release other reservations
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" className="h-9" onClick={() => onQuickUpdate(reservation, "released", "cancelled")}>Release</Button>
                    <Button type="button" variant="ghost" className="h-9" onClick={() => onQuickUpdate(reservation, "cancelled", "cancelled")}>Cancel</Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {editingId === reservation.id && canWrite ? (
              <ReservationForm
                key={`edit-reservation-${reservation.id}`}
                lead={lead}
                reservation={reservation}
                adminProfiles={adminProfiles}
                parcels={parcels}
                reservationSettings={reservationSettings}
                onSubmit={(values) => {
                  onSave(reservation, values);
                  setEditingId(null);
                }}
              />
            ) : null}
            <ReservationActivityList reservation={reservation} activities={activities.filter((activity) => activity.reservation_id === reservation.id)} />
          </div>
        ))}
        {releasePrimary ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-primary/70 p-4" role="dialog" aria-modal="true">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card shadow-xl">
              <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
                <div>
                  <h2 className="text-lg font-semibold text-primary">Release Other Reservations</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Keep {releasePrimary.reservation_code || "this reservation"} {releasePrimary.parcels?.lot_number ? `for Lot ${releasePrimary.parcels.lot_number}` : ""} and release selected alternate holds.
                  </p>
                </div>
                <Button type="button" variant="ghost" className="h-9 px-3" onClick={() => setReleasePrimaryId(null)} disabled={releaseSubmitting}>
                  Close
                </Button>
              </div>
              <div className="max-h-[calc(90vh-96px)] overflow-y-auto p-5">
                <div className="grid gap-4">
                  <div className="crm-warning-panel p-4 text-sm">
                    <p className="font-semibold text-warning">Review selected reservations before releasing.</p>
                    <p className="mt-2 leading-6">
                      Releasing a reservation marks this internal lot hold as no longer active. It does not change parcel
                      status, payments, deposits, contracts, applications, or customer records.
                    </p>
                    <p className="mt-2 leading-6">Only release reservations that are no longer being pursued by this buyer.</p>
                  </div>

                  {releaseAlternates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active alternate reservations were found for this buyer context.</p>
                  ) : (
                    <div className="grid gap-2">
                      {releaseAlternates.map((alternate) => (
                        <label key={alternate.id} className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            checked={releaseSelectedIds.includes(alternate.id)}
                            onChange={() => toggleReleaseSelection(alternate.id)}
                            disabled={releaseSubmitting}
                          />
                          <span className="min-w-0">
                            <span className="block break-words font-medium text-primary">
                              {alternate.reservation_code || "Reservation"} {alternate.parcels?.lot_number ? `- Lot ${alternate.parcels.lot_number}` : ""}
                            </span>
                            <span className="mt-1 block text-muted-foreground">
                              {reservationStatusLabel(alternate.status)} | Deposit {depositStatusLabel(alternate.deposit_status)}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}

                  <Field label="Release reason">
                    <Textarea
                      value={releaseReason}
                      onChange={(event) => setReleaseReason(event.target.value)}
                      placeholder="Example: Buyer confirmed another lot, deposit confirmed for another lot, duplicate/incorrect reservation."
                      disabled={releaseSubmitting}
                    />
                  </Field>

                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setReleasePrimaryId(null)} disabled={releaseSubmitting}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => void submitReleaseAlternates()}
                      disabled={releaseSubmitting || releaseSelectedIds.length === 0 || !releaseReason.trim()}
                    >
                      {releaseSubmitting ? "Releasing..." : "Release Selected"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReservationForm({
  lead,
  reservation,
  adminProfiles,
  parcels,
  reservationSettings,
  onSubmit,
}: {
  lead: LeadWithRelations;
  reservation: ReservationWithRelations | null;
  adminProfiles: AdminProfile[];
  parcels: Array<Pick<Parcel, "id" | "lot_number" | "status">>;
  reservationSettings: ReservationWorkflowSettings;
  onSubmit: (values: ReservationFormValues) => void;
}) {
  const [values, setValues] = useState<ReservationFormValues>(() => reservationToFormValues(reservation, lead, reservationSettings));

  function setField<K extends keyof ReservationFormValues>(key: K, value: ReservationFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  return (
    <form className="grid gap-3 rounded-md border border-primary/10 bg-primary-soft/40 p-3" onSubmit={(event) => { event.preventDefault(); onSubmit(values); }}>
      {reservationSettings.show_reservation_explanations ? (
        <div className="crm-info-panel p-3 text-sm">
          Deposit Readiness tracks whether a deposit is pending, submitted, confirmed, waived, overdue, or cancelled. It does not create payments, change balances, confirm proof, or replace the payment ledger.
        </div>
      ) : null}
      {!reservation && (reservationSettings.require_expiry_date || reservationSettings.require_expected_deposit_amount) ? (
        <div className="crm-warning-panel p-3 text-sm">
          Reservation settings require {reservationSettings.require_expiry_date ? "an expiry date" : ""}
          {reservationSettings.require_expiry_date && reservationSettings.require_expected_deposit_amount ? " and " : ""}
          {reservationSettings.require_expected_deposit_amount ? "an expected deposit amount" : ""} before a new reservation can be saved.
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reservation code">
          <Input value={values.reservation_code} onChange={(event) => setField("reservation_code", event.target.value)} placeholder="Optional" />
        </Field>
        <Field label="Lot">
          <Select value={values.parcel_id} onChange={(event) => setField("parcel_id", event.target.value)}>
            <option value="">No lot selected</option>
            {parcels.map((parcel) => <option key={parcel.id} value={parcel.id}>Lot {parcel.lot_number} ({parcel.status})</option>)}
          </Select>
        </Field>
        <Field label="Reservation status">
          <Select value={values.status} onChange={(event) => setField("status", event.target.value as ReservationStatus)}>
            {reservationStatuses.map((status) => <option key={status} value={status}>{reservationStatusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Deposit status">
          <Select value={values.deposit_status} onChange={(event) => setField("deposit_status", event.target.value as DepositStatus)}>
            {depositStatuses.map((status) => <option key={status} value={status}>{depositStatusLabel(status)}</option>)}
          </Select>
        </Field>
        <Field label="Expected deposit">
          <Input type="number" min="0" step="0.01" value={values.expected_deposit_amount} onChange={(event) => setField("expected_deposit_amount", event.target.value)} />
        </Field>
        <Field label="Deposit due">
          <Input type="datetime-local" value={values.deposit_due_at} onChange={(event) => setField("deposit_due_at", event.target.value)} />
        </Field>
        <Field label="Reserved at">
          <Input type="datetime-local" value={values.reserved_at} onChange={(event) => setField("reserved_at", event.target.value)} />
        </Field>
        <Field label="Expires at">
          <Input type="datetime-local" value={values.expires_at} onChange={(event) => setField("expires_at", event.target.value)} />
        </Field>
        <Field label="Deposit paid at">
          <Input type="datetime-local" value={values.deposit_paid_at} onChange={(event) => setField("deposit_paid_at", event.target.value)} />
        </Field>
        <Field label="Assigned">
          <Select value={values.assigned_to} onChange={(event) => setField("assigned_to", event.target.value)}>
            <option value="">Unassigned</option>
            {adminProfiles.map((profile) => <option key={profile.user_id} value={profile.user_id}>{adminLabel(profile)}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notes">
        <Textarea value={values.notes} onChange={(event) => setField("notes", event.target.value)} />
      </Field>
      <Button type="submit" variant={reservation ? "outline" : "accent"}>{reservation ? "Save Reservation" : "Create Reservation"}</Button>
    </form>
  );
}

function ReservationInsights({ reservation, tasks }: { reservation: LotReservation; tasks: FollowUpTask[] }) {
  const hasOpenFollowUp = tasks.some((task) => task.status === "open" || task.status === "in_progress");
  return (
    <SmartInsightList insights={reservationReadinessInsights(reservation, hasOpenFollowUp)} compact />
  );
}

function ReservationReleasePrompt({
  reservation,
  reservations,
  lead,
  settings,
}: {
  reservation: ReservationWithRelations;
  reservations: ReservationWithRelations[];
  lead: LeadWithRelations;
  settings: ReservationWorkflowSettings;
}) {
  if (!activeReservationStatuses.has(reservation.status)) return null;

  const hasAlternates = alternateReservationsForPrimary(reservation, reservations).length > 0;
  if (!hasAlternates) return null;

  const shouldPromptAfterDeposit =
    settings.prompt_release_alternates_after_deposit_confirmed &&
    (reservation.deposit_status === "confirmed" || reservation.status === "deposit_confirmed");
  const shouldPromptAfterContract =
    settings.prompt_release_alternates_after_contract_started &&
    lead.pipeline_stage === "contract_started";

  if (!shouldPromptAfterDeposit && !shouldPromptAfterContract) return null;

  return (
    <div className="crm-info-panel p-3 text-sm">
      This buyer has other active reservations. Consider releasing alternates that are no longer being pursued.
    </div>
  );
}

function ReservationActivityList({ reservation, activities }: { reservation: LotReservation; activities: ReservationActivity[] }) {
  return (
    <details className="crm-subpanel">
      <summary className="cursor-pointer text-sm font-medium text-primary">Reservation timeline ({activities.length})</summary>
      <div className="mt-3 grid gap-2">
        {activities.length === 0 ? <p className="text-xs text-muted-foreground">No reservation activity recorded.</p> : null}
        {activities.map((activity) => (
          <div key={activity.id} className="rounded-md border-l-4 border-primary/25 bg-muted p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="break-words font-medium text-primary">{activity.title}</p>
              <Badge tone="gray">{reservationActivityLabel(activity.activity_type)}</Badge>
            </div>
            {activity.description ? <p className="mt-1 break-words text-muted-foreground">{activity.description}</p> : null}
            <p className="mt-1 text-muted-foreground">{formatDate(activity.created_at)}</p>
          </div>
        ))}
        {reservation.payment_id ? <p className="text-xs text-muted-foreground">Linked payment record: #{reservation.payment_id}</p> : null}
      </div>
    </details>
  );
}

type TaskFormValues = {
  title: string;
  description: string;
  due_at: string;
  priority: FollowUpTaskPriority;
  assigned_to: string;
};

function TaskForm({ adminProfiles, lead, onSubmit }: { adminProfiles: AdminProfile[]; lead: Lead; onSubmit: (values: TaskFormValues) => void }) {
  const [values, setValues] = useState<TaskFormValues>({ title: lead.next_action ?? "", description: "", due_at: toDateTimeLocal(lead.next_action_due_at), priority: "normal", assigned_to: lead.assigned_to ?? "" });
  return (
    <Card>
      <CardHeader>
        <CardTitle>New Follow-up</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">A Follow-up is an internal task reminding staff what action should happen next with a lead, applicant, or customer.</p>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(values); setValues({ title: "", description: "", due_at: "", priority: "normal", assigned_to: lead.assigned_to ?? "" }); }}>
          <Field label="Title"><Input value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} required /></Field>
          <Field label="Due"><Input type="datetime-local" value={values.due_at} onChange={(event) => setValues({ ...values, due_at: event.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority">
              <Select value={values.priority} onChange={(event) => setValues({ ...values, priority: event.target.value as FollowUpTaskPriority })}>
                {taskPriorities.map((priority) => <option key={priority} value={priority}>{taskPriorityLabel(priority)}</option>)}
              </Select>
            </Field>
            <Field label="Assigned">
              <Select value={values.assigned_to} onChange={(event) => setValues({ ...values, assigned_to: event.target.value })}>
                <option value="">Unassigned</option>
                {adminProfiles.map((profile) => <option key={profile.user_id} value={profile.user_id}>{adminLabel(profile)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description"><Textarea value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></Field>
          <Button type="submit">Create Follow-up</Button>
        </form>
      </CardContent>
    </Card>
  );
}

type VisitFormValues = {
  scheduled_at: string;
  visit_type: string;
  location: string;
  notes: string;
  assigned_to: string;
};

function VisitForm({ adminProfiles, lead, onSubmit }: { adminProfiles: AdminProfile[]; lead: Lead; onSubmit: (values: VisitFormValues) => void }) {
  const [values, setValues] = useState<VisitFormValues>({ scheduled_at: "", visit_type: "Site Visit", location: "", notes: "", assigned_to: lead.assigned_to ?? "" });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule Site Visit</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">Site Visits are appointments to view a project or lot. They are separate from reservations.</p>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(values); setValues({ scheduled_at: "", visit_type: "Site Visit", location: "", notes: "", assigned_to: lead.assigned_to ?? "" }); }}>
          <Field label="Scheduled date/time"><Input type="datetime-local" value={values.scheduled_at} onChange={(event) => setValues({ ...values, scheduled_at: event.target.value })} required /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Visit type"><Input value={values.visit_type} onChange={(event) => setValues({ ...values, visit_type: event.target.value })} /></Field>
            <Field label="Assigned">
              <Select value={values.assigned_to} onChange={(event) => setValues({ ...values, assigned_to: event.target.value })}>
                <option value="">Unassigned</option>
                {adminProfiles.map((profile) => <option key={profile.user_id} value={profile.user_id}>{adminLabel(profile)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Location"><Input value={values.location} onChange={(event) => setValues({ ...values, location: event.target.value })} /></Field>
          <Field label="Notes"><Textarea value={values.notes} onChange={(event) => setValues({ ...values, notes: event.target.value })} /></Field>
          <Button type="submit" variant="accent"><CalendarDays className="h-4 w-4" />Schedule Visit</Button>
        </form>
      </CardContent>
    </Card>
  );
}

type ActivityFormValues = {
  activity_type: LeadActivityType;
  title: string;
  description: string;
};

function ActivityForm({ onSubmit }: { onSubmit: (values: ActivityFormValues) => void }) {
  const [values, setValues] = useState<ActivityFormValues>({ activity_type: "note", title: "", description: "" });
  return (
    <Card>
      <CardHeader><CardTitle>Add Timeline Note</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(values); setValues({ activity_type: "note", title: "", description: "" }); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Activity type">
              <Select value={values.activity_type} onChange={(event) => setValues({ ...values, activity_type: event.target.value as LeadActivityType })}>
                {activityTypes.map((type) => <option key={type} value={type}>{activityTypeLabel(type)}</option>)}
              </Select>
            </Field>
            <Field label="Title"><Input value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} required /></Field>
          </div>
          <Field label="Description"><Textarea value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></Field>
          <Button type="submit" variant="outline"><ClipboardList className="h-4 w-4" />Add Activity</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TasksCard({ tasks, canWrite, onUpdate }: { tasks: FollowUpTask[]; canWrite: boolean; onUpdate: (task: FollowUpTask, status: FollowUpTaskStatus) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle>Follow-ups</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {tasks.length === 0 ? <p className="text-sm text-muted-foreground">No follow-ups recorded.</p> : null}
        {tasks.map((task) => (
          <div key={task.id} className="grid gap-3 rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="break-words font-medium text-primary">{task.title}</p>
                <p className="text-muted-foreground">{task.due_at ? formatDate(task.due_at) : "No due date"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={taskStatusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
                <Badge tone={priorityTone(task.priority)}>{taskPriorityLabel(task.priority)}</Badge>
              </div>
            </div>
            {task.description ? <p className="break-words text-muted-foreground">{task.description}</p> : null}
            {canWrite && task.status !== "completed" && task.status !== "cancelled" ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="h-9" onClick={() => onUpdate(task, "completed")}><CheckCircle2 className="h-4 w-4" />Complete</Button>
                <Button type="button" variant="ghost" className="h-9" onClick={() => onUpdate(task, "cancelled")}><XCircle className="h-4 w-4" />Cancel</Button>
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function VisitsCard({ visits, canWrite, onUpdate }: { visits: SiteVisit[]; canWrite: boolean; onUpdate: (visit: SiteVisit, status: SiteVisitStatus) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Site Visits</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">Site Visits are viewing appointments and do not hold a lot or confirm buyer readiness.</p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {visits.length === 0 ? <p className="text-sm text-muted-foreground">No site visits scheduled.</p> : null}
        {visits.map((visit) => (
          <div key={visit.id} className="grid gap-3 rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="break-words font-medium text-primary">{visit.visit_type ?? "Site Visit"}</p>
                <p className="text-muted-foreground">{formatDate(visit.scheduled_at)}</p>
              </div>
              <Badge tone={visitStatusTone(visit.status)}>{visitStatusLabel(visit.status)}</Badge>
            </div>
            {visit.location ? <p className="break-words text-muted-foreground">Location: {visit.location}</p> : null}
            {visit.notes ? <p className="break-words text-muted-foreground">{visit.notes}</p> : null}
            {canWrite && visit.status !== "completed" && visit.status !== "cancelled" ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="h-9" onClick={() => onUpdate(visit, "completed")}><CheckCircle2 className="h-4 w-4" />Complete</Button>
                <Button type="button" variant="ghost" className="h-9" onClick={() => onUpdate(visit, "no_show")}>No Show</Button>
                <Button type="button" variant="ghost" className="h-9" onClick={() => onUpdate(visit, "cancelled")}><XCircle className="h-4 w-4" />Cancel</Button>
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function TimelineCard({ activities }: { activities: LeadActivity[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Activity Timeline</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {activities.length === 0 ? <p className="text-sm text-muted-foreground">No activity has been recorded yet.</p> : null}
        {activities.map((activity) => (
          <div key={activity.id} className="rounded-md border-l-4 border-primary/30 bg-muted p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="break-words font-medium text-primary">{activity.title}</p>
              <Badge tone="gray">{activityTypeLabel(activity.activity_type)}</Badge>
            </div>
            {activity.description ? <p className="mt-2 break-words text-muted-foreground">{activity.description}</p> : null}
            <p className="mt-2 text-xs text-muted-foreground">{formatDate(activity.created_at)}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PipelineBadge({ stage }: { stage: LeadPipelineStage }) {
  const meta = pipelineStages.find((item) => item.value === stage) ?? pipelineStages[0];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-subpanel">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-foreground">{value}</p>
    </div>
  );
}

function normalizeLeadValues(values: LeadFormValues) {
  return {
    full_name: values.full_name.trim(),
    email: values.email.trim() || null,
    phone: values.phone.trim() || null,
    whatsapp: values.whatsapp.trim() || null,
    parcel_id: values.parcel_id ? Number(values.parcel_id) : null,
    application_id: values.application_id ? Number(values.application_id) : null,
    customer_id: values.customer_id ? Number(values.customer_id) : null,
    source: values.source.trim() || null,
    pipeline_stage: values.pipeline_stage,
    buyer_journey_stage: values.buyer_journey_stage.trim() || null,
    decision_blocker: values.decision_blocker.trim() || null,
    budget_min: values.budget_min ? Number(values.budget_min) : null,
    budget_max: values.budget_max ? Number(values.budget_max) : null,
    preferred_contact_method: values.preferred_contact_method.trim() || null,
    assigned_to: values.assigned_to || null,
    next_action: values.next_action.trim() || null,
    next_action_due_at: values.next_action_due_at ? new Date(values.next_action_due_at).toISOString() : null,
    notes: values.notes.trim() || null,
    lost_reason: values.lost_reason.trim() || null,
  };
}

function leadToFormValues(lead: LeadWithRelations | null): LeadFormValues {
  return {
    full_name: lead?.full_name ?? "",
    email: lead?.email ?? "",
    phone: lead?.phone ?? "",
    whatsapp: lead?.whatsapp ?? "",
    parcel_id: lead?.parcel_id ? String(lead.parcel_id) : "",
    application_id: lead?.application_id ? String(lead.application_id) : "",
    customer_id: lead?.customer_id ? String(lead.customer_id) : "",
    source: lead?.source ?? "",
    pipeline_stage: lead?.pipeline_stage ?? "new_lead",
    buyer_journey_stage: lead?.buyer_journey_stage ?? "",
    decision_blocker: lead?.decision_blocker ?? "",
    budget_min: lead?.budget_min ? String(lead.budget_min) : "",
    budget_max: lead?.budget_max ? String(lead.budget_max) : "",
    preferred_contact_method: lead?.preferred_contact_method ?? "",
    assigned_to: lead?.assigned_to ?? "",
    next_action: lead?.next_action ?? "",
    next_action_due_at: toDateTimeLocal(lead?.next_action_due_at),
    notes: lead?.notes ?? "",
    lost_reason: lead?.lost_reason ?? "",
  };
}

function normalizeReservationValues(values: ReservationFormValues) {
  return {
    reservation_code: values.reservation_code.trim() || null,
    parcel_id: values.parcel_id ? Number(values.parcel_id) : null,
    status: values.status,
    deposit_status: values.deposit_status,
    expected_deposit_amount: values.expected_deposit_amount ? Number(values.expected_deposit_amount) : null,
    deposit_due_at: values.deposit_due_at ? new Date(values.deposit_due_at).toISOString() : null,
    deposit_paid_at: values.deposit_paid_at ? new Date(values.deposit_paid_at).toISOString() : null,
    reserved_at: values.reserved_at ? new Date(values.reserved_at).toISOString() : null,
    expires_at: values.expires_at ? new Date(values.expires_at).toISOString() : null,
    assigned_to: values.assigned_to || null,
    notes: values.notes.trim() || null,
  };
}

function reservationToFormValues(reservation: LotReservation | null, lead: Lead, settings: ReservationWorkflowSettings = reservationWorkflowDefaults): ReservationFormValues {
  const defaultExpectedDeposit =
    settings.default_expected_deposit_amount !== null ? String(settings.default_expected_deposit_amount) : "";

  return {
    reservation_code: reservation?.reservation_code ?? "",
    parcel_id: reservation?.parcel_id ? String(reservation.parcel_id) : lead.parcel_id ? String(lead.parcel_id) : "",
    status: reservation?.status ?? settings.default_reservation_status,
    deposit_status: reservation?.deposit_status ?? settings.default_deposit_status,
    expected_deposit_amount: reservation?.expected_deposit_amount ? String(reservation.expected_deposit_amount) : defaultExpectedDeposit,
    deposit_due_at: toDateTimeLocal(reservation?.deposit_due_at ?? futureIsoFromDays(settings.default_deposit_due_days)),
    deposit_paid_at: toDateTimeLocal(reservation?.deposit_paid_at),
    reserved_at: toDateTimeLocal(reservation ? reservation.reserved_at : new Date().toISOString()),
    expires_at: toDateTimeLocal(reservation?.expires_at ?? futureIsoFromDays(settings.default_reservation_expiry_days)),
    assigned_to: reservation?.assigned_to ?? lead.assigned_to ?? "",
    notes: reservation?.notes ?? "",
  };
}

function ReservationBadge({ status }: { status: ReservationStatus }) {
  return <Badge tone={reservationStatusTone(status)}>{reservationStatusLabel(status)}</Badge>;
}

function DepositBadge({ status }: { status: DepositStatus }) {
  return <Badge tone={depositStatusTone(status)}>{depositStatusLabel(status)}</Badge>;
}

function reservationStatusLabel(status: ReservationStatus) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function depositStatusLabel(status: DepositStatus) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reservationActivityLabel(type: ReservationActivityType) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reservationStatusTone(status: ReservationStatus): BadgeTone {
  if (["deposit_confirmed", "converted_to_application", "converted_to_contract"].includes(status)) return "green";
  if (["deposit_pending", "expired"].includes(status)) return "amber";
  if (["deposit_submitted", "reserved"].includes(status)) return "blue";
  if (status === "cancelled") return "red";
  return "gray";
}

function depositStatusTone(status: DepositStatus): BadgeTone {
  if (status === "confirmed") return "green";
  if (status === "pending") return "amber";
  if (status === "proof_submitted") return "blue";
  if (status === "overdue") return "red";
  if (status === "waived") return "brown";
  return "gray";
}

function readinessLabel(status: string) {
  return safeString(status, "Unknown").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readinessTone(status: string): BadgeTone {
  if (["closed", "contract_ready", "application_ready"].includes(status)) return "green";
  if (["blocked"].includes(status)) return "red";
  if (["needs_follow_up", "deposit_readiness", "gathering_information"].includes(status)) return "amber";
  if (["inactive", "unknown"].includes(status)) return "gray";
  return "blue";
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function safeString(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function safeFormatDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return formatDate(date.toISOString());
}

function adminLabel(profile: AdminProfile) {
  return profile.full_name || profile.email || profile.user_id;
}

function adminLabelById(profiles: AdminProfile[] | undefined, id: string | null) {
  if (!id) return "Unassigned";
  return adminLabel(profiles?.find((profile) => profile.user_id === id) ?? { user_id: id, full_name: null, email: null, role: "Read Only", created_at: "", updated_at: "" });
}

function applicationName(application: Pick<Application, "applicant_full_name" | "first_name" | "last_name">) {
  return application.applicant_full_name || `${application.first_name} ${application.last_name}`.trim();
}

function stageLabel(stage: LeadPipelineStage) {
  return pipelineStages.find((item) => item.value === stage)?.label ?? stage;
}

function taskStatusLabel(status: FollowUpTaskStatus) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function taskPriorityLabel(priority: FollowUpTaskPriority) {
  return priority.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function visitStatusLabel(status: SiteVisitStatus) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityTypeLabel(type: LeadActivityType) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function budgetLabel(lead: Lead) {
  if (lead.budget_min && lead.budget_max) return `${money(lead.budget_min)} - ${money(lead.budget_max)}`;
  if (lead.budget_min) return `From ${money(lead.budget_min)}`;
  if (lead.budget_max) return `Up to ${money(lead.budget_max)}`;
  return "Not recorded";
}

function sharesLeadContext(reservation: LotReservation, lead: Lead) {
  return (
    reservation.lead_id === lead.id ||
    (lead.application_id !== null && reservation.application_id === lead.application_id) ||
    (lead.customer_id !== null && reservation.customer_id === lead.customer_id)
  );
}

function sharesReservationContext(primary: LotReservation, alternate: LotReservation) {
  return (
    (primary.lead_id !== null && alternate.lead_id === primary.lead_id) ||
    (primary.application_id !== null && alternate.application_id === primary.application_id) ||
    (primary.customer_id !== null && alternate.customer_id === primary.customer_id)
  );
}

function alternateReservationsForPrimary(primary: ReservationWithRelations, reservations: ReservationWithRelations[]) {
  return reservations.filter((reservation) =>
    reservation.id !== primary.id &&
    activeReservationStatuses.has(reservation.status) &&
    sharesReservationContext(primary, reservation) &&
    (primary.parcel_id === null || reservation.parcel_id !== primary.parcel_id)
  );
}

function isOverdue(value: string | null, now: Date) {
  return Boolean(value && new Date(value) < now);
}

function isToday(date: Date) {
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  return date >= today && date < tomorrow;
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function taskStatusTone(status: FollowUpTaskStatus): BadgeTone {
  if (status === "completed") return "green";
  if (status === "cancelled") return "gray";
  if (status === "in_progress") return "blue";
  return "amber";
}

function priorityTone(priority: FollowUpTaskPriority): BadgeTone {
  if (priority === "urgent") return "red";
  if (priority === "high") return "amber";
  if (priority === "low") return "gray";
  return "blue";
}

function visitStatusTone(status: SiteVisitStatus): BadgeTone {
  if (status === "completed") return "green";
  if (status === "cancelled") return "gray";
  if (status === "no_show") return "red";
  if (status === "rescheduled") return "amber";
  return "blue";
}
