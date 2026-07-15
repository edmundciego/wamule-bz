import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, statusBadgeTone, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Field";
import { SmartInsightsPanel } from "../components/ui/SmartInsightsPanel";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile, updateApplicationStatus } from "../lib/data";
import { fetchReservationWorkflowSettings, futureIsoFromDays, reservationWorkflowDefaults } from "../lib/reservationSettings";
import { applicationSmartInsights, activeReservationStatuses } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/utils";
import type { Application, ApplicationAiReview, ApplicationStatus, AppRole, Lead, LotReservation, PostSalesChecklist } from "../types/database";

const statuses: ApplicationStatus[] = ["Pending Review", "Approved", "Declined"];
type ReviewFilter = ApplicationStatus | "All";
type ApplicationRow = Application & {
  parcels?: { id: number; lot_number: string | null; status: string | null } | null;
  application_ai_reviews?: ApplicationAiReview[] | ApplicationAiReview | null;
};
type LotOption = { id: number; lot_number: string | null; dimensions: string | null; status: string | null };

export function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [selectedLots, setSelectedLots] = useState<Record<number, string>>({});
  const [selectedStatus, setSelectedStatus] = useState<ReviewFilter>("Pending Review");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedApplicationId, setSelectedApplicationId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generatingReviewId, setGeneratingReviewId] = useState<number | null>(null);
  const requestedApplicationId = searchParams.get("application");
  const { data: sessionProfile } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["applications-kanban"],
    queryFn: async () => {
      const { data: applications, error: queryError } = await supabase
        .from("applications")
        .select("*, parcels(id, lot_number, status), application_ai_reviews(*)")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return applications as ApplicationRow[];
    },
  });
  const { data: aiSettings } = useQuery({
    queryKey: ["application-ai-settings"],
    queryFn: async () => {
      const { data: settings, error: queryError } = await supabase
        .from("ai_settings")
        .select("is_enabled, application_summary_enabled")
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (queryError) throw queryError;
      return settings;
    },
  });
  const { data: lotOptions } = useQuery({
    queryKey: ["available-lots-for-approval"],
    queryFn: async () => {
      const { data: parcels, error: queryError } = await supabase
        .from("parcels")
        .select("id, lot_number, dimensions, status")
        .order("lot_number");
      if (queryError) throw queryError;
      return parcels as LotOption[];
    },
  });
  const { data: linkedLeads } = useQuery({
    queryKey: ["application-linked-leads"],
    queryFn: async () => {
      const { data: leads, error: queryError } = await supabase
        .from("leads")
        .select("id, application_id, pipeline_stage, full_name, source, assigned_to, next_action, next_action_due_at, possible_duplicate, duplicate_reason")
        .not("application_id", "is", null);
      if (queryError) throw queryError;
      return leads as Pick<Lead, "id" | "application_id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at" | "possible_duplicate" | "duplicate_reason">[];
    },
  });
  const { data: linkedReservations } = useQuery({
    queryKey: ["application-linked-reservations"],
    queryFn: async () => {
      const { data: reservations, error: queryError } = await supabase
        .from("lot_reservations")
        .select("*")
        .or("application_id.not.is.null,lead_id.not.is.null");
      if (queryError) throw queryError;
      return reservations as LotReservation[];
    },
  });
  const { data: reservationSettings = reservationWorkflowDefaults } = useQuery({
    queryKey: ["reservation-workflow-settings"],
    queryFn: fetchReservationWorkflowSettings,
  });
  const { data: postSalesChecklists } = useQuery({
    queryKey: ["application-post-sales-checklists"],
    queryFn: async () => {
      const { data: checklists, error: queryError } = await supabase
        .from("post_sales_checklists")
        .select("*")
        .not("application_id", "is", null);
      if (queryError) throw queryError;
      return checklists as PostSalesChecklist[];
    },
  });

  async function setStatus(id: number, status: ApplicationStatus) {
    setActionError(null);
    const parcelId = selectedLots[id] ? Number(selectedLots[id]) : undefined;
    try {
      await updateApplicationStatus(id, status, parcelId);
      await queryClient.invalidateQueries({ queryKey: ["applications-kanban"] });
      await queryClient.invalidateQueries({ queryKey: ["lot-board"] });
      await queryClient.invalidateQueries({ queryKey: ["available-lots-for-approval"] });
    } catch (statusError) {
      setActionError((statusError as Error).message);
    }
  }

  async function generateReview(applicationId: number) {
    setActionError(null);
    setGeneratingReviewId(applicationId);
    const { data: result, error: functionError } = await supabase.functions.invoke("generate-application-review", {
      body: { application_id: applicationId },
    });
    setGeneratingReviewId(null);
    if (functionError) {
      setActionError(functionError.message);
      return;
    }
    if (result?.error) {
      setActionError(String(result.error));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["applications-kanban"] });
  }

  async function createLeadFromApplication(application: {
    id: number;
    applicant_full_name: string | null;
    first_name: string;
    last_name: string;
    phone: string;
    email: string | null;
    parcel_id: number | null;
    intended_use: string | null;
    payment_option: string | null;
  }) {
    setActionError(null);
    const existingLead = linkedLeads?.find((lead) => lead.application_id === application.id);
    if (existingLead) return;
    const leadName = (application.applicant_full_name ?? `${application.first_name} ${application.last_name}`).trim();
    const { data: insertedLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        full_name: leadName || `Application #${application.id}`,
        phone: application.phone,
        email: application.email,
        parcel_id: application.parcel_id,
        application_id: application.id,
        source: "Public Application Form",
        pipeline_stage: "application_started",
        buyer_journey_stage: "New Application",
        preferred_contact_method: application.email ? "Email" : "Phone",
        next_action: "Review public application and follow up with applicant",
        next_action_due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        notes: [application.intended_use, application.payment_option].filter(Boolean).join(" | ") || null,
      })
      .select("id")
      .single();
    if (insertError) {
      setActionError(insertError.code === "23505" ? "A lead is already linked to this application." : insertError.message);
      return;
    }
    const { error: taskError } = await supabase.from("follow_up_tasks").insert({
      lead_id: insertedLead.id,
      application_id: application.id,
      title: "Follow up on public application",
      description: "Review the application, confirm buyer readiness, and contact the applicant.",
      due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      status: "open",
      priority: "high",
    });
    if (taskError) {
      setActionError(taskError.message);
      return;
    }
    const { error: activityError } = await supabase.from("lead_activities").insert({
      lead_id: insertedLead.id,
      activity_type: "application_linked",
      title: "Lead created from public application",
      description: `Application #${application.id} linked for sales follow-up.`,
      metadata: null,
    });
    if (activityError) {
      setActionError(activityError.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["application-linked-leads"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-leads"] });
  }

  async function createReservationFromApplication(application: {
    id: number;
    parcel_id: number | null;
    applicant_full_name: string | null;
    first_name: string;
    last_name: string;
  }) {
    setActionError(null);
    const linkedLead = linkedLeads?.find((lead) => lead.application_id === application.id) ?? null;
    const selectedParcelId = application.parcel_id ?? (selectedLots[application.id] ? Number(selectedLots[application.id]) : null);
    const existingReservation = linkedReservations?.find((reservation) =>
      reservation.application_id === application.id ||
      (linkedLead?.id && reservation.lead_id === linkedLead.id) ||
      (selectedParcelId && reservation.parcel_id === selectedParcelId && activeReservationStatuses.has(reservation.status))
    );
    if (existingReservation) return;
    const expiresAt = futureIsoFromDays(reservationSettings.default_reservation_expiry_days);
    const depositDueAt = futureIsoFromDays(reservationSettings.default_deposit_due_days);
    const expectedDepositAmount = reservationSettings.default_expected_deposit_amount;
    if (reservationSettings.require_expiry_date && !expiresAt) {
      setActionError("Reservation settings require an expiry date, but no default expiry days are configured.");
      return;
    }
    if (reservationSettings.require_expected_deposit_amount && expectedDepositAmount === null) {
      setActionError("Reservation settings require an expected deposit amount, but no default amount is configured.");
      return;
    }
    const { data: reservation, error: insertError } = await supabase
      .from("lot_reservations")
      .insert({
        lead_id: linkedLead?.id ?? null,
        application_id: application.id,
        parcel_id: selectedParcelId,
        status: reservationSettings.default_reservation_status,
        deposit_status: reservationSettings.default_deposit_status,
        expected_deposit_amount: expectedDepositAmount,
        deposit_due_at: depositDueAt,
        expires_at: expiresAt,
        reserved_at: new Date().toISOString(),
        notes: `Created from application for ${(application.applicant_full_name ?? `${application.first_name} ${application.last_name}`).trim() || `Application #${application.id}`}.`,
      })
      .select("id")
      .single();
    if (insertError) {
      setActionError(insertError.code === "23505" ? "This lot already has an active reservation hold." : insertError.message);
      return;
    }
    const { error: activityError } = await supabase.from("reservation_activities").insert({
      reservation_id: reservation.id,
      activity_type: "application_linked",
      title: "Reservation linked to application",
      description: `Application #${application.id} linked for deposit readiness tracking.`,
      metadata: null,
    });
    if (activityError) {
      console.warn("Reservation activity was not recorded", activityError);
    }
    await queryClient.invalidateQueries({ queryKey: ["application-linked-reservations"] });
    await queryClient.invalidateQueries({ queryKey: ["sales-lot-reservations"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard-lot-reservations"] });
    await queryClient.invalidateQueries({ queryKey: ["lot-board-active-reservations"] });
  }

  function preferredLotText(preferredParcelIds: unknown) {
    if (!Array.isArray(preferredParcelIds) || !lotOptions) return "None listed";
    const labels = preferredParcelIds
      .map((id) => lotOptions.find((lot) => lot.id === Number(id))?.lot_number ?? String(id))
      .map((lotNumber) => `Lot ${lotNumber}`);
    return labels.length > 0 ? labels.join(", ") : "None listed";
  }

  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canWriteSales = currentRole === "Super Admin" || currentRole === "Admin" || currentRole === "Staff";
  const canGenerateAiReview = currentRole === "Super Admin" || currentRole === "Admin";
  const aiReviewEnabled = Boolean(aiSettings?.is_enabled && aiSettings.application_summary_enabled);
  const applications = useMemo(() => data ?? [], [data]);
  useEffect(() => {
    if (!requestedApplicationId || !applications.some((application) => String(application.id) === requestedApplicationId)) return;
    setSelectedApplicationId(Number(requestedApplicationId));
  }, [applications, requestedApplicationId]);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredApplications = applications.filter((application) => {
    const matchesStatus = selectedStatus === "All" || application.status === selectedStatus;
    const searchable = [
      applicationName(application),
      application.phone,
      application.email ?? "",
      application.parcels?.lot_number ? `Lot ${application.parcels.lot_number}` : "",
      preferredLotText(application.preferred_parcel_ids),
      application.intended_use ?? "",
      application.payment_option ?? "",
    ].join(" ").toLowerCase();
    return matchesStatus && (!normalizedSearch || searchable.includes(normalizedSearch));
  });
  const selectedApplication = requestedApplicationId
    ? applications.find((application) => String(application.id) === requestedApplicationId) ?? null
    : applications.find((application) => application.id === selectedApplicationId) ?? filteredApplications[0] ?? applications[0] ?? null;

  return (
    <>
      <section className="mx-auto grid max-w-[1520px] gap-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Application Review</p>
            <h1 className="mt-2 text-3xl font-semibold text-primary">Applications</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Review buyer applications, lot preferences, missing information, and next steps.
            </p>
          </div>
        </div>

        <ApplicationReviewStrip
          applications={applications}
          selectedStatus={selectedStatus}
          onSelectStatus={setSelectedStatus}
        />
      </section>
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {actionError ? <div className="mb-4"><ErrorState message={actionError} /></div> : null}
      <section className="mx-auto mt-6 grid max-w-[1520px] gap-6 xl:grid-cols-[minmax(320px,0.38fr)_minmax(0,1fr)]">
        <ApplicationReviewQueue
          applications={filteredApplications}
          selectedApplicationId={selectedApplication?.id ?? null}
          searchQuery={searchQuery}
          preferredLotText={preferredLotText}
          linkedLeads={linkedLeads}
          linkedReservations={linkedReservations}
          lotOptions={lotOptions}
          postSalesChecklists={postSalesChecklists}
          onSearchChange={setSearchQuery}
          onSelect={(application) => setSelectedApplicationId(application.id)}
        />
        {selectedApplication ? (
          <ApplicationWorkbench
            application={selectedApplication}
            preferredLotText={preferredLotText}
            selectedLotValue={selectedLots[selectedApplication.id] ?? ""}
            lotOptions={lotOptions}
            linkedLead={linkedLeads?.find((item) => item.application_id === selectedApplication.id) ?? null}
            linkedReservation={applicationReservation(
              selectedApplication.id,
              selectedApplication.parcel_id ?? (selectedLots[selectedApplication.id] ? Number(selectedLots[selectedApplication.id]) : null),
              linkedLeads,
              linkedReservations,
            )}
            postSalesChecklist={postSalesChecklists?.find((checklist) => checklist.application_id === selectedApplication.id) ?? null}
            canWriteSales={canWriteSales}
            canGenerateAiReview={canGenerateAiReview}
            aiReviewEnabled={aiReviewEnabled}
            generatingReview={generatingReviewId === selectedApplication.id}
            selectedLotStatus={lotOptions?.find((lot) => lot.id === (selectedApplication.parcel_id ?? (selectedLots[selectedApplication.id] ? Number(selectedLots[selectedApplication.id]) : null)))?.status ?? selectedApplication.parcels?.status ?? null}
            onSelectedLotChange={(value) =>
              setSelectedLots((current) => ({
                ...current,
                [selectedApplication.id]: value,
              }))
            }
            onCreateLead={() => void createLeadFromApplication(selectedApplication)}
            onCreateReservation={() => void createReservationFromApplication(selectedApplication)}
            onGenerateReview={() => void generateReview(selectedApplication.id)}
            onApprove={() => void setStatus(selectedApplication.id, "Approved")}
            onDecline={() => void setStatus(selectedApplication.id, "Declined")}
            onBackToQueue={() => setSelectedApplicationId(null)}
          />
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {requestedApplicationId ? "The requested application is no longer available or you do not have access to it." : "No applications match the current review filter."}
          </div>
        )}
      </section>
    </>
  );
}

function ApplicationReviewStrip({
  applications,
  selectedStatus,
  onSelectStatus,
}: {
  applications: ApplicationRow[];
  selectedStatus: ReviewFilter;
  onSelectStatus: (status: ReviewFilter) => void;
}) {
  const filters: ReviewFilter[] = ["All", ...statuses];
  return (
    <div className="overflow-x-auto rounded-xl border border-primary/15 bg-primary-soft/45 p-2 shadow-sm shadow-primary/5">
      <div className="flex min-w-max gap-2">
        {filters.map((status) => {
          const count = status === "All" ? applications.length : applications.filter((application) => application.status === status).length;
          const active = selectedStatus === status;
          return (
            <button
              key={status}
              type="button"
              className={[
                "flex min-h-12 items-center gap-3 rounded-lg px-4 text-left text-sm transition",
                active ? "bg-primary text-primary-foreground shadow-sm shadow-primary/10" : "bg-card/75 text-primary hover:bg-card",
              ].join(" ")}
              onClick={() => onSelectStatus(status)}
            >
              <span className="font-semibold">{status}</span>
              <span className={active ? "text-primary-foreground/75" : "text-muted-foreground"}>{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ApplicationReviewQueue({
  applications,
  selectedApplicationId,
  searchQuery,
  preferredLotText,
  linkedLeads,
  linkedReservations,
  lotOptions,
  postSalesChecklists,
  onSearchChange,
  onSelect,
}: {
  applications: ApplicationRow[];
  selectedApplicationId: number | null;
  searchQuery: string;
  preferredLotText: (preferredParcelIds: unknown) => string;
  linkedLeads: Pick<Lead, "id" | "application_id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at" | "possible_duplicate" | "duplicate_reason">[] | undefined;
  linkedReservations: LotReservation[] | undefined;
  lotOptions: LotOption[] | undefined;
  postSalesChecklists: PostSalesChecklist[] | undefined;
  onSearchChange: (value: string) => void;
  onSelect: (application: ApplicationRow) => void;
}) {
  return (
    <aside className="grid min-w-0 gap-4 xl:sticky xl:top-6 xl:max-h-[calc(100vh-8rem)] xl:grid-rows-[auto_minmax(0,1fr)]">
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm shadow-primary/5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Review Queue</p>
        <Input
          className="mt-3"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search applicant, phone, lot, use..."
        />
      </div>
      <div className="grid min-h-0 gap-3 overflow-visible xl:overflow-y-auto xl:pr-1">
        {applications.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
            No applications match this view.
          </div>
        ) : null}
        {applications.map((application) => {
          const linkedLead = linkedLeads?.find((item) => item.application_id === application.id) ?? null;
          const selectedParcelId = application.parcel_id;
          const linkedReservation = applicationReservation(application.id, selectedParcelId, linkedLeads, linkedReservations);
          const postSalesChecklist = postSalesChecklists?.find((checklist) => checklist.application_id === application.id) ?? null;
          const selectedLotStatus = lotOptions?.find((lot) => lot.id === selectedParcelId)?.status ?? application.parcels?.status ?? null;
          const missingFacts = knownMissingFacts(application);
          const selected = selectedApplicationId === application.id;

          return (
            <button
              key={application.id}
              type="button"
              className={[
                "group min-w-0 rounded-xl border p-4 text-left shadow-sm transition",
                selected ? "border-primary/30 bg-primary-soft/60 shadow-primary/10" : "border-border bg-card hover:border-primary/20 hover:bg-primary-soft/20",
              ].join(" ")}
              onClick={() => onSelect(application)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-base font-semibold text-primary">{applicationName(application)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{application.phone}</p>
                </div>
                <Badge tone={statusBadgeTone(application.status)}>{application.status}</Badge>
              </div>
              <div className="mt-4 grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span>Preferred</span>
                  <span className="min-w-0 truncate font-medium text-primary">{preferredLotText(application.preferred_parcel_ids)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Submitted</span>
                  <span className="font-medium text-primary">{formatDate(application.created_at)}</span>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {selectedLotStatus && selectedLotStatus !== "Available" && application.status !== "Approved" ? <Badge tone="red">Lot issue</Badge> : null}
                {missingFacts.length ? <Badge tone="amber">{missingFacts.length} missing</Badge> : <Badge tone="green">Required fields</Badge>}
                {linkedLead?.possible_duplicate ? <Badge tone="amber">Possible duplicate</Badge> : null}
                {linkedReservation ? <Badge tone={reservationTone(linkedReservation.status)}>Reservation</Badge> : null}
                {postSalesChecklist ? <Badge tone={postSalesTone(postSalesChecklist.status)}>Post-Sales</Badge> : null}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function ApplicationWorkbench({
  application,
  preferredLotText,
  selectedLotValue,
  lotOptions,
  linkedLead,
  linkedReservation,
  postSalesChecklist,
  canWriteSales,
  canGenerateAiReview,
  aiReviewEnabled,
  generatingReview,
  selectedLotStatus,
  onSelectedLotChange,
  onCreateLead,
  onCreateReservation,
  onGenerateReview,
  onApprove,
  onDecline,
  onBackToQueue,
}: {
  application: ApplicationRow;
  preferredLotText: (preferredParcelIds: unknown) => string;
  selectedLotValue: string;
  lotOptions: LotOption[] | undefined;
  linkedLead: Pick<Lead, "id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at" | "possible_duplicate" | "duplicate_reason"> | null;
  linkedReservation: LotReservation | null;
  postSalesChecklist: PostSalesChecklist | null;
  canWriteSales: boolean;
  canGenerateAiReview: boolean;
  aiReviewEnabled: boolean;
  generatingReview: boolean;
  selectedLotStatus: string | null;
  onSelectedLotChange: (value: string) => void;
  onCreateLead: () => void;
  onCreateReservation: () => void;
  onGenerateReview: () => void;
  onApprove: () => void;
  onDecline: () => void;
  onBackToQueue: () => void;
}) {
  const missingFacts = knownMissingFacts(application);
  const review = firstReview(application.application_ai_reviews);
  const preferredLotLabel = preferredLotText(application.preferred_parcel_ids);
  const lotConflict = Boolean(selectedLotStatus && selectedLotStatus !== "Available" && application.status !== "Approved");

  return (
    <main className="grid min-w-0 gap-5">
      <section className="overflow-hidden rounded-xl border border-primary/15 bg-[linear-gradient(135deg,#fffaf0_0%,#f6f0df_48%,#ecf3e6_100%)] shadow-[0_20px_60px_rgba(45,35,23,0.10)]">
        <div className="grid gap-5 p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <button type="button" className="mb-3 text-sm font-semibold text-primary xl:hidden" onClick={onBackToQueue}>
                Back to queue
              </button>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Application Workbench</p>
              <h2 className="mt-2 break-words text-3xl font-semibold leading-tight text-primary">{applicationName(application)}</h2>
              <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
                <span className="rounded-md border border-primary/10 bg-card/70 px-3 py-2">Submitted {formatDate(application.created_at)}</span>
                <span className="rounded-md border border-primary/10 bg-card/70 px-3 py-2">{application.phone}</span>
                {application.email ? <span className="rounded-md border border-primary/10 bg-card/70 px-3 py-2">{application.email}</span> : null}
              </div>
            </div>
            <DecisionActions
              application={application}
              selectedLotValue={selectedLotValue}
              lotOptions={lotOptions}
              onSelectedLotChange={onSelectedLotChange}
              onApprove={onApprove}
              onDecline={onDecline}
            />
          </div>
          <CurrentReviewState
            application={application}
            missingFacts={missingFacts}
            lotConflict={lotConflict}
            selectedLotStatus={selectedLotStatus}
            linkedLead={linkedLead}
            linkedReservation={linkedReservation}
            postSalesChecklist={postSalesChecklist}
          />
        </div>
      </section>

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 gap-5">
          <LotPreferenceWorkspace
            application={application}
            preferredLotLabel={preferredLotLabel}
            selectedLotStatus={selectedLotStatus}
          />
          <MissingInformationPanel missingFacts={missingFacts} application={application} selectedLotStatus={selectedLotStatus} linkedLead={linkedLead} postSalesChecklist={postSalesChecklist} />
          <ApplicantInformation application={application} />
          <BuyerJourneyPanel
            lead={linkedLead}
            reservation={linkedReservation}
            postSalesChecklist={postSalesChecklist}
            applicationStatus={application.status}
            canWrite={canWriteSales}
            hasLot={Boolean(application.parcel_id || selectedLotValue)}
            onCreateLead={onCreateLead}
            onCreateReservation={onCreateReservation}
          />
        </div>
        <div className="grid min-w-0 gap-5 content-start">
          <ApplicationAiReviewSection
            review={review}
            canGenerate={canGenerateAiReview}
            aiReviewEnabled={aiReviewEnabled}
            generating={generatingReview}
            onGenerate={onGenerateReview}
          />
          <ApplicationContextPanel application={application} />
        </div>
      </div>
    </main>
  );
}

function CurrentReviewState({
  application,
  missingFacts,
  lotConflict,
  selectedLotStatus,
  linkedLead,
  linkedReservation,
  postSalesChecklist,
}: {
  application: ApplicationRow;
  missingFacts: string[];
  lotConflict: boolean;
  selectedLotStatus: string | null;
  linkedLead: Pick<Lead, "id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at" | "possible_duplicate" | "duplicate_reason"> | null;
  linkedReservation: LotReservation | null;
  postSalesChecklist: PostSalesChecklist | null;
}) {
  return (
    <div className="grid overflow-hidden rounded-xl border border-primary/15 bg-card shadow-sm shadow-primary/5 sm:grid-cols-2 xl:grid-cols-4">
      <ReviewStateCell label="Status" value={application.status} detail={application.status === "Pending Review" ? "Decision pending" : "Stable application state"} tone={statusBadgeTone(application.status)} />
      <ReviewStateCell label="Lot" value={lotConflict ? "Needs review" : selectedLotStatus ?? "Not selected"} detail={lotConflict ? `Current lot status is ${selectedLotStatus}` : application.parcels?.lot_number ? `Assigned Lot ${application.parcels.lot_number}` : "No assigned lot"} tone={lotConflict ? "red" : selectedLotStatus === "Available" ? "green" : "gray"} />
      <ReviewStateCell label="Missing" value={missingFacts.length ? `${missingFacts.length} item${missingFacts.length === 1 ? "" : "s"}` : "Clear"} detail={missingFacts[0] ?? "Known required fields present"} tone={missingFacts.length ? "amber" : "green"} />
      <ReviewStateCell label="Journey" value={linkedLead ? "Lead linked" : "No lead"} detail={linkedReservation ? `Reservation ${reservationLabel(linkedReservation.status)}` : postSalesChecklist ? `Post-Sales ${statusLabel(postSalesChecklist.status)}` : "No reservation linked"} tone={linkedLead || linkedReservation || postSalesChecklist ? "blue" : "gray"} />
    </div>
  );
}

function ReviewStateCell({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: BadgeTone }) {
  return (
    <div className="min-w-0 border-b border-primary/10 bg-primary-soft/30 p-4 last:border-b-0 sm:odd:border-r xl:border-b-0 xl:border-r xl:last:border-r-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
        <Badge tone={tone}>{value}</Badge>
      </div>
      <p className="mt-2 min-h-5 break-words text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function DecisionActions({
  application,
  selectedLotValue,
  lotOptions,
  onSelectedLotChange,
  onApprove,
  onDecline,
}: {
  application: ApplicationRow;
  selectedLotValue: string;
  lotOptions: LotOption[] | undefined;
  onSelectedLotChange: (value: string) => void;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="grid w-full gap-3 rounded-xl border border-primary/15 bg-card/80 p-4 shadow-sm shadow-primary/5 lg:w-[320px]">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Review Decision</p>
      {application.status !== "Approved" ? (
        <Select value={selectedLotValue} onChange={(event) => onSelectedLotChange(event.target.value)}>
          <option value="">Select lot to reserve</option>
          {lotOptions
            ?.filter((lot) => lot.status === "Available")
            .map((lot) => (
              <option key={lot.id} value={lot.id}>
                Lot {lot.lot_number} - {lot.dimensions}
              </option>
            ))}
        </Select>
      ) : (
        <p className="text-sm text-muted-foreground">Approved applications keep their recorded lot/customer context.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {application.status !== "Approved" ? <Button type="button" onClick={onApprove}>Approve</Button> : null}
        {application.status !== "Declined" ? <Button type="button" variant="outline" onClick={onDecline}>Decline</Button> : null}
      </div>
    </div>
  );
}

function LotPreferenceWorkspace({
  application,
  preferredLotLabel,
  selectedLotStatus,
}: {
  application: ApplicationRow;
  preferredLotLabel: string;
  selectedLotStatus: string | null;
}) {
  const lotConflict = Boolean(selectedLotStatus && selectedLotStatus !== "Available" && application.status !== "Approved");
  return (
    <section className="rounded-xl border border-primary/15 bg-primary-soft/35 p-5 shadow-sm shadow-primary/5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">Lot Preference</h3>
          <p className="mt-1 text-sm text-muted-foreground">Preferred lot direction and availability context for review.</p>
        </div>
        {lotConflict ? <Badge tone="red">Lot unavailable</Badge> : <Badge tone={selectedLotStatus === "Available" ? "green" : "gray"}>{selectedLotStatus ?? "No lot selected"}</Badge>}
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.5fr)]">
        <div className="rounded-lg border border-primary/10 bg-card/80 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Preferred lot</p>
          <p className="mt-2 text-2xl font-semibold text-primary">{application.parcels?.lot_number ? `Lot ${application.parcels.lot_number}` : preferredLotLabel}</p>
          <div className="mt-4 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <span>Parcel count: {application.parcel_count ?? "Not provided"}</span>
            <span>Current status: {selectedLotStatus ?? "Not selected"}</span>
          </div>
          {lotConflict ? (
            <div className="mt-4 rounded-md border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
              This lot is currently marked {selectedLotStatus}. Staff should review lot availability before approval.
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-primary/10 bg-card/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Alternative</p>
          <p className="mt-2 break-words text-base font-semibold text-primary">{application.alternate_lot_preference ?? "Not provided"}</p>
          <p className="mt-4 text-sm text-muted-foreground">Alternative lot information is supporting context and does not change the preferred lot.</p>
        </div>
      </div>
    </section>
  );
}

function MissingInformationPanel({
  missingFacts,
  application,
  selectedLotStatus,
  linkedLead,
  postSalesChecklist,
}: {
  missingFacts: string[];
  application: ApplicationRow;
  selectedLotStatus: string | null;
  linkedLead: Pick<Lead, "id" | "next_action"> | null;
  postSalesChecklist: PostSalesChecklist | null;
}) {
  return (
    <section className="grid gap-4 rounded-xl border border-primary/15 bg-primary-soft/25 p-5 shadow-sm shadow-primary/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-primary">Missing Information</h3>
          <p className="mt-1 text-sm text-muted-foreground">Known application facts are separated from smart guidance.</p>
        </div>
        <Badge tone={missingFacts.length ? "amber" : "green"}>{missingFacts.length ? `${missingFacts.length} known item${missingFacts.length === 1 ? "" : "s"}` : "Known fields clear"}</Badge>
      </div>
      {missingFacts.length ? (
        <div className="grid gap-2">
          {missingFacts.map((item) => (
            <div key={item} className="rounded-md border border-warning/20 bg-accent-soft p-3 text-sm text-warning">
              {item}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-primary/10 bg-card/70 p-3 text-sm text-muted-foreground">No known required application facts are missing.</p>
      )}
      <div className="rounded-xl border border-secondary/20 bg-[#fff8e6] p-4 shadow-sm shadow-secondary/10">
        <SmartInsightsPanel
          title="Review Guidance"
          description="Rule-based application guidance. Approval remains manual."
          insights={applicationSmartInsights({
            application,
            selectedLotStatus,
            linkedLead,
            postSalesChecklist,
          })}
          compact
        />
      </div>
    </section>
  );
}

function ApplicantInformation({ application }: { application: ApplicationRow }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm shadow-primary/5">
      <h3 className="text-lg font-semibold text-primary">Applicant Information</h3>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <DefinitionGroup title="Identity / Contact" rows={[
          ["Name", applicationName(application)],
          ["Nationality", application.nationality ?? "Not provided"],
          ["Occupation", application.occupation ?? "Not provided"],
          ["Phone", application.phone],
          ["Email", application.email ?? "Not provided"],
          ["Address", application.applicant_address ?? "Not provided"],
        ]} />
        <DefinitionGroup title="Submitted Use" rows={[
          ["Intended use", `${application.intended_use ?? "Not provided"}${application.intended_use_other ? ` - ${application.intended_use_other}` : ""}`],
          ["Payment option", application.payment_option ?? "Not provided"],
          ["Legal notice", application.legal_notice_acknowledged ? "Acknowledged" : "Missing"],
          ["Signature", application.applicant_acknowledgement_signature ? "Recorded" : "Not recorded"],
          ["Cultural review", application.cultural_preservation_review ?? "Not provided"],
          ["Sustainability terms", application.sustainability_terms_verified ? "Verified" : "Not verified"],
        ]} />
      </div>
    </section>
  );
}

function DefinitionGroup({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <p className="text-sm font-semibold text-primary">{title}</p>
      <div className="mt-3 grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-b border-border/70 pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[140px_minmax(0,1fr)]">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 break-words font-medium text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BuyerJourneyPanel({
  lead,
  reservation,
  postSalesChecklist,
  applicationStatus,
  canWrite,
  hasLot,
  onCreateLead,
  onCreateReservation,
}: {
  lead: Pick<Lead, "id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at" | "possible_duplicate" | "duplicate_reason"> | null;
  reservation: LotReservation | null;
  postSalesChecklist: PostSalesChecklist | null;
  applicationStatus: ApplicationStatus;
  canWrite: boolean;
  hasLot: boolean;
  onCreateLead: () => void;
  onCreateReservation: () => void;
}) {
  return (
    <section className="rounded-xl border border-primary/15 bg-primary-soft/30 p-5 shadow-sm shadow-primary/5">
      <h3 className="text-lg font-semibold text-primary">Buyer Journey</h3>
      <p className="mt-1 text-sm text-muted-foreground">Linked operational records around this application.</p>
      <div className="mt-5 grid gap-3">
        <ApplicationLeadLink lead={lead} canWrite={canWrite} onCreate={onCreateLead} />
        <ApplicationReservationLink reservation={reservation} canWrite={canWrite} hasLot={hasLot} onCreate={onCreateReservation} />
        <ApplicationPostSalesLink checklist={postSalesChecklist} applicationStatus={applicationStatus} />
      </div>
    </section>
  );
}

function ApplicationContextPanel({ application }: { application: ApplicationRow }) {
  return (
    <section className="rounded-xl border border-border/80 bg-muted/40 p-4 shadow-sm shadow-primary/5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Application Context</p>
      <div className="mt-4 grid gap-3 text-sm">
        <ContextRow label="Application ID" value={`#${application.id}`} />
        <ContextRow label="Submitted" value={formatDate(application.created_at)} />
        <ContextRow label="Updated" value={formatDate(application.updated_at)} />
        <ContextRow label="Status" value={application.status} />
      </div>
      {application.notes ? <p className="mt-4 break-words rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">{application.notes}</p> : null}
    </section>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-semibold text-primary">{value}</span>
    </div>
  );
}

function ApplicationAiReviewSection({
  review,
  canGenerate,
  aiReviewEnabled,
  generating,
  onGenerate,
}: {
  review: ApplicationAiReview | null;
  canGenerate: boolean;
  aiReviewEnabled: boolean;
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="grid gap-4 rounded-xl border border-secondary/25 bg-[#fff8e6] p-4 text-sm shadow-sm shadow-secondary/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Decision Support</p>
          <p className="text-xs text-muted-foreground">Smart review guidance only. Admin remains responsible for final decisions.</p>
        </div>
        {review ? <Badge tone={reviewTone(review.completeness_status)}>{review.completeness_status}</Badge> : <Badge tone="gray">Not generated</Badge>}
      </div>

      {!aiReviewEnabled ? (
        <p className="crm-warning-panel p-2 text-xs">
          Application decision support is not enabled. Enable it in Settings.
        </p>
      ) : null}

      {review ? (
        <div className="grid gap-3">
          <p className="break-words rounded-md border border-secondary/15 bg-card/70 p-3 leading-6 text-primary">{review.summary}</p>
          <ReviewList title="Missing fields" items={review.missing_fields} emptyLabel="No missing fields flagged." />
          <ReviewList title="Risk flags" items={review.risk_flags} emptyLabel="No risk flags listed." />
          <ReviewList title="Recommended admin actions" items={review.recommended_admin_actions} emptyLabel="No extra actions listed." />
          <div className="grid gap-1 text-xs text-muted-foreground">
            <span>Model: {review.model}</span>
            <span>Generated: {formatDate(review.updated_at || review.created_at)}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No smart review has been generated for this application yet.</p>
      )}

      {canGenerate ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" disabled={generating} onClick={onGenerate}>
            {generating ? "Generating..." : review ? "Regenerate Review" : "Generate Review"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ApplicationLeadLink({
  lead,
  canWrite,
  onCreate,
}: {
  lead: Pick<Lead, "id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at" | "possible_duplicate" | "duplicate_reason"> | null;
  canWrite: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="v2-record-row flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-medium text-primary">Sales Pipeline</p>
        <p className="text-xs text-muted-foreground">
          {lead
            ? `${lead.full_name} is linked for follow-up. Stage: ${leadStageLabel(lead.pipeline_stage)}. ${lead.next_action_due_at ? `Due: ${formatDate(lead.next_action_due_at)}.` : "No due date recorded."}`
            : "Older applications without a linked lead can be added to the sales pipeline manually."}
        </p>
        {lead ? (
          <div className="mt-1 grid gap-1 text-xs text-muted-foreground">
            <p>
              Source: {lead.source ?? "Not recorded"} · Assigned: {lead.assigned_to ? "Assigned" : "Unassigned"} · Action: {lead.next_action ?? "Review application"}
            </p>
            {lead.possible_duplicate ? (
              <p className="max-w-full break-words text-amber-700">
                Possible duplicate: {lead.duplicate_reason ?? "Review matching application or lead records."}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {lead ? (
        <div className="flex flex-wrap gap-2">
          {lead.possible_duplicate ? <Badge tone="amber">Possible Duplicate</Badge> : null}
          <Badge tone="blue">Lead Created</Badge>
          <Link to="/leads">
            <Button type="button" variant="outline" className="h-9">
              View Lead
            </Button>
          </Link>
        </div>
      ) : canWrite ? (
        <Button type="button" variant="outline" className="h-9" onClick={onCreate}>
          Create Lead
        </Button>
      ) : null}
    </div>
  );
}

function leadStageLabel(stage: Lead["pipeline_stage"]) {
  if (stage === "application_started") return "New Application";
  return statusLabel(stage);
}

function ApplicationReservationLink({
  reservation,
  canWrite,
  hasLot,
  onCreate,
}: {
  reservation: LotReservation | null;
  canWrite: boolean;
  hasLot: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="v2-record-row flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-medium text-primary">Reservation / Deposit Readiness</p>
        <p className="text-xs text-muted-foreground">
          {reservation
            ? `Reservation is ${reservationLabel(reservation.status)} with deposit ${depositLabel(reservation.deposit_status)}.`
            : hasLot
              ? "Create a draft reservation to track an internal lot hold and deposit readiness."
              : "Assign or select a lot before creating a reservation hold."}
        </p>
      </div>
      {reservation ? (
        <div className="flex flex-wrap gap-2">
          <Badge tone={reservationTone(reservation.status)}>{reservationLabel(reservation.status)}</Badge>
          <Badge tone={depositTone(reservation.deposit_status)}>{depositLabel(reservation.deposit_status)}</Badge>
        </div>
      ) : canWrite && hasLot ? (
        <Button type="button" variant="outline" className="h-9" onClick={onCreate}>
          Create Reservation
        </Button>
      ) : null}
    </div>
  );
}

function ApplicationPostSalesLink({
  checklist,
  applicationStatus,
}: {
  checklist: PostSalesChecklist | null;
  applicationStatus: ApplicationStatus;
}) {
  if (applicationStatus !== "Approved" && !checklist) return null;
  return (
    <div className="v2-record-row flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-medium text-primary">Post-Sales Checklist</p>
        <p className="text-xs text-muted-foreground">
          {checklist
            ? `Checklist is ${statusLabel(checklist.status)}. Agreement ${statusLabel(checklist.agreement_status)}, documents ${statusLabel(checklist.document_status)}.`
            : "Start the post-sales checklist from Customer Detail after approval."}
        </p>
      </div>
      {checklist ? (
        <div className="flex flex-wrap gap-2">
          <Badge tone={postSalesTone(checklist.status)}>{statusLabel(checklist.status)}</Badge>
          <Badge tone={agreementTone(checklist.agreement_status)}>{statusLabel(checklist.agreement_status)}</Badge>
        </div>
      ) : (
        <Badge tone="gray">Not Started</Badge>
      )}
    </div>
  );
}

function ReviewList({ title, items, emptyLabel }: { title: string; items: string[]; emptyLabel: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">{title}</p>
      {items.length ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

function applicationName(application: Pick<Application, "applicant_full_name" | "first_name" | "last_name">) {
  return (application.applicant_full_name ?? `${application.first_name} ${application.last_name}`).trim() || `Application`;
}

function knownMissingFacts(application: ApplicationRow) {
  const missing: string[] = [];
  if (!applicationName(application) || applicationName(application) === "Application") missing.push("Applicant name is missing.");
  if (!application.phone) missing.push("Phone number is missing.");
  if (!application.email) missing.push("Email is missing.");
  if (!application.intended_use) missing.push("Intended use is missing.");
  if (!application.payment_option) missing.push("Payment option is missing.");
  if (!application.legal_notice_acknowledged) missing.push("Legal notice acknowledgement is missing.");
  return missing;
}

function firstReview(value: unknown): ApplicationAiReview | null {
  if (Array.isArray(value)) return (value[0] as ApplicationAiReview | undefined) ?? null;
  return (value as ApplicationAiReview | null) ?? null;
}

function reviewTone(status: ApplicationAiReview["completeness_status"]) {
  if (status === "Complete") return "green";
  if (status === "Lot Conflict") return "red";
  if (status === "Missing Information") return "amber";
  return "blue";
}

function applicationReservation(
  applicationId: number,
  parcelId: number | null,
  leads: Pick<Lead, "id" | "application_id">[] | undefined,
  reservations: LotReservation[] | undefined,
) {
  const lead = leads?.find((item) => item.application_id === applicationId);
  return reservations?.find((reservation) =>
    reservation.application_id === applicationId ||
    (lead?.id && reservation.lead_id === lead.id) ||
    (parcelId && reservation.parcel_id === parcelId && activeReservationStatuses.has(reservation.status))
  ) ?? null;
}

function reservationLabel(status: LotReservation["status"]) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function depositLabel(status: LotReservation["deposit_status"]) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function reservationTone(status: LotReservation["status"]): BadgeTone {
  if (["deposit_confirmed", "converted_to_application", "converted_to_contract"].includes(status)) return "green";
  if (["deposit_pending", "expired"].includes(status)) return "amber";
  if (["reserved", "deposit_submitted"].includes(status)) return "blue";
  if (status === "cancelled") return "red";
  return "gray";
}

function depositTone(status: LotReservation["deposit_status"]): BadgeTone {
  if (status === "confirmed") return "green";
  if (status === "pending") return "amber";
  if (status === "proof_submitted") return "blue";
  if (status === "overdue") return "red";
  if (status === "waived") return "brown";
  return "gray";
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function postSalesTone(status: PostSalesChecklist["status"]): BadgeTone {
  if (status === "completed") return "green";
  if (status === "blocked") return "red";
  if (status === "in_progress") return "blue";
  return "gray";
}

function agreementTone(status: PostSalesChecklist["agreement_status"]): BadgeTone {
  if (status === "signed") return "green";
  if (status === "blocked") return "red";
  if (status === "ready_for_review") return "amber";
  if (status === "drafting" || status === "sent_for_signature") return "blue";
  return "gray";
}
