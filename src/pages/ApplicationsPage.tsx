import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge, statusBadgeTone, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Select } from "../components/ui/Field";
import { SmartInsightsPanel } from "../components/ui/SmartInsightsPanel";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile, updateApplicationStatus } from "../lib/data";
import { fetchReservationWorkflowSettings, futureIsoFromDays, reservationWorkflowDefaults } from "../lib/reservationSettings";
import { applicationSmartInsights, activeReservationStatuses } from "../lib/smartInsights";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/utils";
import type { ApplicationAiReview, ApplicationStatus, AppRole, Lead, LotReservation, PostSalesChecklist } from "../types/database";

const statuses: ApplicationStatus[] = ["Pending Review", "Approved", "Declined"];

export function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [selectedLots, setSelectedLots] = useState<Record<number, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [generatingReviewId, setGeneratingReviewId] = useState<number | null>(null);
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
      return applications;
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
      return parcels;
    },
  });
  const { data: linkedLeads } = useQuery({
    queryKey: ["application-linked-leads"],
    queryFn: async () => {
      const { data: leads, error: queryError } = await supabase
        .from("leads")
        .select("id, application_id, pipeline_stage, full_name, source, assigned_to, next_action, next_action_due_at")
        .not("application_id", "is", null);
      if (queryError) throw queryError;
      return leads as Pick<Lead, "id" | "application_id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at">[];
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

  return (
    <>
      <PageHeader title="Applications" description="Review intake applications and approve qualifying applicants." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {actionError ? <div className="mb-4"><ErrorState message={actionError} /></div> : null}
      <div className="crm-info-panel mb-4 p-4 text-sm">
        Applications can be linked to a lead or reservation so staff can track the buyer journey from interest to application review.
        Public applications are automatically added to the sales pipeline as leads for follow-up. This does not approve the application or reserve a lot.
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {statuses.map((status) => (
          <section key={status} className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">{status}</h2>
              <Badge tone={statusBadgeTone(status)}>
                {data?.filter((item) => item.status === status).length ?? 0}
              </Badge>
            </div>
            <div className="grid gap-3">
              {data
                ?.filter((item) => item.status === status)
                .map((application) => {
                  const linkedLead = linkedLeads?.find((item) => item.application_id === application.id) ?? null;
                  const selectedParcelId = application.parcel_id ?? (selectedLots[application.id] ? Number(selectedLots[application.id]) : null);
                  const linkedReservation = applicationReservation(application.id, selectedParcelId, linkedLeads, linkedReservations);
                  const postSalesChecklist = postSalesChecklists?.find((checklist) => checklist.application_id === application.id) ?? null;
                  const selectedLotStatus = lotOptions?.find((lot) => lot.id === selectedParcelId)?.status ?? application.parcels?.status ?? null;

                  return (
                  <Card key={application.id}>
                    <CardContent className="grid gap-3 p-4">
                      <div>
                        <p className="font-medium">{application.applicant_full_name ?? `${application.first_name} ${application.last_name}`}</p>
                        <p className="text-sm text-muted-foreground">{application.phone}</p>
                      </div>
                      <div className="grid gap-1 text-sm">
                        <p>Assigned lot: {application.parcels?.lot_number ?? "Not assigned"}</p>
                        <p>Preferred lots: {preferredLotText(application.preferred_parcel_ids)}</p>
                        <p>Alternate: {application.alternate_lot_preference ?? "Not provided"}</p>
                        <p>Use: {application.intended_use ?? "Not provided"}{application.intended_use_other ? ` - ${application.intended_use_other}` : ""}</p>
                        <p>Payment: {application.payment_option ?? "Not provided"}</p>
                        <p>Created: {formatDate(application.created_at)}</p>
                        <p>{application.legal_notice_acknowledged ? "Legal notice acknowledged" : "Missing legal acknowledgement"}</p>
                      </div>
                      <ApplicationLeadLink
                        lead={linkedLead}
                        canWrite={canWriteSales}
                        onCreate={() => void createLeadFromApplication(application)}
                      />
                      <ApplicationReservationLink
                        reservation={linkedReservation}
                        canWrite={canWriteSales}
                        hasLot={Boolean(application.parcel_id || selectedLots[application.id])}
                        onCreate={() => void createReservationFromApplication(application)}
                      />
                      <ApplicationPostSalesLink
                        checklist={postSalesChecklist}
                        applicationStatus={application.status}
                      />
                      <SmartInsightsPanel
                        title="Missing Information"
                        description="Rule-based application guidance. Approval remains manual."
                        insights={applicationSmartInsights({
                          application,
                          selectedLotStatus,
                          linkedLead,
                          postSalesChecklist,
                        })}
                        compact
                      />
                      <ApplicationAiReviewSection
                        review={firstReview(application.application_ai_reviews)}
                        canGenerate={canGenerateAiReview}
                        aiReviewEnabled={aiReviewEnabled}
                        generating={generatingReviewId === application.id}
                        onGenerate={() => void generateReview(application.id)}
                      />
                      {status !== "Approved" ? (
                        <Select
                          value={selectedLots[application.id] ?? ""}
                          onChange={(event) =>
                            setSelectedLots((current) => ({
                              ...current,
                              [application.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Select lot to reserve</option>
                          {lotOptions
                            ?.filter((lot) => lot.status === "Available")
                            .map((lot) => (
                              <option key={lot.id} value={lot.id}>
                                Lot {lot.lot_number} - {lot.dimensions}
                              </option>
                            ))}
                        </Select>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {status !== "Approved" ? <Button type="button" onClick={() => void setStatus(application.id, "Approved")}>Approve</Button> : null}
                        {status !== "Declined" ? <Button type="button" variant="outline" onClick={() => void setStatus(application.id, "Declined")}>Decline</Button> : null}
                      </div>
                    </CardContent>
                  </Card>
                  );
                })}
            </div>
          </section>
        ))}
      </div>
    </>
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
    <div className="grid gap-3 rounded-md border border-primary/10 bg-primary-soft p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-primary">Decision Support</p>
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
        <div className="grid gap-2">
          <p>{review.summary}</p>
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
  lead: Pick<Lead, "id" | "pipeline_stage" | "full_name" | "source" | "assigned_to" | "next_action" | "next_action_due_at"> | null;
  canWrite: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="crm-subpanel flex flex-wrap items-center justify-between gap-3 text-sm">
      <div>
        <p className="font-medium text-primary">Sales Pipeline</p>
        <p className="text-xs text-muted-foreground">
          {lead
            ? `${lead.full_name} is linked for follow-up. Stage: ${leadStageLabel(lead.pipeline_stage)}. ${lead.next_action_due_at ? `Due: ${formatDate(lead.next_action_due_at)}.` : "No due date recorded."}`
            : "Older applications without a linked lead can be added to the sales pipeline manually."}
        </p>
        {lead ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Source: {lead.source ?? "Not recorded"} · Assigned: {lead.assigned_to ? "Assigned" : "Unassigned"} · Action: {lead.next_action ?? "Review application"}
          </p>
        ) : null}
      </div>
      {lead ? (
        <div className="flex flex-wrap gap-2">
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
    <div className="crm-subpanel flex flex-wrap items-center justify-between gap-3 text-sm">
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
    <div className="crm-subpanel flex flex-wrap items-center justify-between gap-3 text-sm">
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
