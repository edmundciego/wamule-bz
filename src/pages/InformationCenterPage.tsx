import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Check,
  Clipboard,
  FileCheck2,
  FilePlus2,
  FileText,
  Mail,
  Plus,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/State";
import { useCompanyProfile } from "../lib/brand";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";
import type { AppRole, InstallmentPlan, Lead, Parcel } from "../types/database";

type InformationRequestStatus =
  | "requested"
  | "draft_generated"
  | "ready_for_review"
  | "approved"
  | "sent"
  | "needs_revision"
  | "cancelled";

type InformationCommunicationStatus =
  | "action_required"
  | "follow_up_scheduled"
  | "waiting_for_customer"
  | "customer_responded"
  | "long_term_follow_up"
  | "closed";

type InformationTopic = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  default_content: string;
  sort_order: number;
  is_active: boolean;
};

type LeadOption = Pick<
  Lead,
  "id" | "full_name" | "email" | "phone" | "assigned_to" | "pipeline_stage" | "updated_at"
>;

type ParcelOption = Pick<Parcel, "id" | "lot_number" | "base_price" | "status" | "dimensions">;

type InformationPackSnapshot = {
  company: {
    company_name: string;
    logo_url: string;
    contact_email: string;
    phone_number: string;
    website: string;
    location_address: string;
    short_description: string;
  };
  project: {
    name: string;
    description: string;
    location: string;
  };
  recipient: {
    name: string;
    email: string | null;
    phone: string | null;
  };
  selected_lot: ParcelOption | null;
  availability: {
    available_count: number;
    minimum_price: number | null;
    maximum_price: number | null;
  };
  topics: Array<{
    code: string;
    name: string;
    description: string | null;
    content: string;
  }>;
  payment_plans: Array<Pick<InstallmentPlan, "id" | "name" | "description" | "reservation_fee" | "initial_deposit" | "final_purchase_price" | "term_months" | "monthly_payment">>;
  custom_request: string | null;
  next_step: string;
  generated_at: string;
};

type InformationPack = {
  id: string;
  request_id: string;
  version: number;
  document_number: string;
  title: string;
  status: "draft" | "approved" | "superseded";
  introduction: string | null;
  content_snapshot: InformationPackSnapshot;
  file_path: string | null;
  generated_by: string | null;
  approved_by: string | null;
  generated_at: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type InformationRequest = {
  id: string;
  lead_id: string;
  parcel_id: number | null;
  project_name: string;
  custom_request: string | null;
  personalized_intro: string | null;
  status: InformationRequestStatus;
  communication_status: InformationCommunicationStatus;
  assigned_to: string | null;
  requested_at: string;
  approved_at: string | null;
  approved_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
  sent_channel: string | null;
  follow_up_task_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  leads?: LeadOption | null;
  parcels?: ParcelOption | null;
  information_request_topics?: Array<{
    topic_id: string;
    information_topics?: InformationTopic | null;
  }>;
  information_packs?: InformationPack[];
};

const requestStatusLabels: Record<InformationRequestStatus, string> = {
  requested: "Requested",
  draft_generated: "Draft Generated",
  ready_for_review: "Ready for Review",
  approved: "Approved",
  sent: "Sent",
  needs_revision: "Needs Revision",
  cancelled: "Cancelled",
};

const communicationStatusLabels: Record<InformationCommunicationStatus, string> = {
  action_required: "Action Required",
  follow_up_scheduled: "Follow-Up Scheduled",
  waiting_for_customer: "Waiting for Customer",
  customer_responded: "Customer Responded",
  long_term_follow_up: "Long-Term Follow-Up",
  closed: "Closed",
};

const requestStatusTones: Record<InformationRequestStatus, BadgeTone> = {
  requested: "blue",
  draft_generated: "brown",
  ready_for_review: "amber",
  approved: "green",
  sent: "green",
  needs_revision: "red",
  cancelled: "gray",
};

export function InformationCenterPage() {
  const queryClient = useQueryClient();
  const { company, companyName } = useCompanyProfile();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [leadId, setLeadId] = useState("");
  const [parcelId, setParcelId] = useState("");
  const [projectName, setProjectName] = useState(companyName);
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>([]);
  const [customRequest, setCustomRequest] = useState("");
  const [personalizedIntro, setPersonalizedIntro] = useState("");
  const [sentChannel, setSentChannel] = useState("Email");
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: sessionProfile } = useQuery({
    queryKey: ["session-profile"],
    queryFn: getSessionAndProfile,
  });

  const { data: topics, isLoading: topicsLoading } = useQuery({
    queryKey: ["information-topics"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("information_topics")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return data as InformationTopic[];
    },
  });

  const { data: leads, isLoading: leadsLoading } = useQuery({
    queryKey: ["information-centre-leads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("id, full_name, email, phone, assigned_to, pipeline_stage, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as LeadOption[];
    },
  });

  const { data: parcels } = useQuery({
    queryKey: ["information-centre-parcels"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("parcels")
        .select("id, lot_number, base_price, status, dimensions")
        .order("lot_number", { ascending: true });
      if (error) throw error;
      return data as ParcelOption[];
    },
  });

  const { data: plans } = useQuery({
    queryKey: ["information-centre-plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("installment_plans")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as InstallmentPlan[];
    },
  });

  const {
    data: requests,
    isLoading: requestsLoading,
    error: requestsError,
  } = useQuery({
    queryKey: ["information-requests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("information_requests")
        .select(
          "*, leads(id, full_name, email, phone, assigned_to, pipeline_stage, updated_at), parcels(id, lot_number, base_price, status, dimensions), information_request_topics(topic_id, information_topics(*)), information_packs(*)",
        )
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data as InformationRequest[];
    },
  });

  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canWrite = currentRole === "Super Admin" || currentRole === "Admin" || currentRole === "Staff";
  const selectedRequest = useMemo(
    () => requests?.find((request) => request.id === selectedRequestId) ?? requests?.[0] ?? null,
    [requests, selectedRequestId],
  );
  const latestPack = selectedRequest ? latestInformationPack(selectedRequest.information_packs) : null;
  const selectedRequestTopics = selectedRequest ? requestTopics(selectedRequest) : [];

  function resetCreateForm() {
    setLeadId("");
    setParcelId("");
    setProjectName(companyName);
    setSelectedTopicIds([]);
    setCustomRequest("");
    setPersonalizedIntro("");
  }

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setMessage(null);
    if (!leadId) return setActionError("Select a lead.");
    if (selectedTopicIds.length === 0 && !customRequest.trim()) {
      return setActionError("Select at least one information topic or enter a custom request.");
    }
    setSaving("create");
    const lead = leads?.find((row) => row.id === leadId) ?? null;
    const userId = sessionProfile?.session?.user.id ?? null;
    const { data: insertedRequest, error: requestError } = await supabase
      .from("information_requests")
      .insert({
        lead_id: leadId,
        parcel_id: parcelId ? Number(parcelId) : null,
        project_name: projectName.trim() || companyName,
        custom_request: customRequest.trim() || null,
        personalized_intro: personalizedIntro.trim() || null,
        assigned_to: lead?.assigned_to ?? userId,
        created_by: userId,
      })
      .select("id")
      .single();
    if (requestError) {
      setSaving(null);
      return setActionError(requestError.message);
    }

    if (selectedTopicIds.length > 0) {
      const { error: topicError } = await supabase.from("information_request_topics").insert(
        selectedTopicIds.map((topicId) => ({ request_id: insertedRequest.id, topic_id: topicId })),
      );
      if (topicError) {
        setSaving(null);
        return setActionError(topicError.message);
      }
    }

    const selectedNames = topics
      ?.filter((topic) => selectedTopicIds.includes(topic.id))
      .map((topic) => topic.name)
      .join(", ");
    const { error: activityError } = await supabase.from("lead_activities").insert({
      lead_id: leadId,
      activity_type: "note",
      title: "Additional information requested",
      description: [selectedNames, customRequest.trim()].filter(Boolean).join(" · ") || "Information request recorded.",
      metadata: { information_request_id: insertedRequest.id },
      created_by: userId,
    });
    if (activityError) {
      setSaving(null);
      return setActionError(activityError.message);
    }

    setSaving(null);
    setCreateOpen(false);
    resetCreateForm();
    setSelectedRequestId(insertedRequest.id);
    setMessage("Information request created.");
    await refreshInformationData(queryClient);
  }

  async function generateDraft(request: InformationRequest) {
    setActionError(null);
    setMessage(null);
    setSaving(`generate-${request.id}`);
    const userId = sessionProfile?.session?.user.id ?? null;
    const lead = request.leads ?? leads?.find((row) => row.id === request.lead_id) ?? null;
    const selectedLot = request.parcels ?? parcels?.find((row) => row.id === request.parcel_id) ?? null;
    const requestTopicRows = requestTopics(request);
    const availableLots = (parcels ?? []).filter((parcel) => parcel.status === "Available");
    const availablePrices = availableLots.map((parcel) => Number(parcel.base_price)).filter(Number.isFinite);
    const nextVersion = Math.max(0, ...(request.information_packs ?? []).map((pack) => pack.version)) + 1;
    const dateCode = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const documentNumber = `INFO-${dateCode}-${request.id.slice(0, 8).toUpperCase()}-V${nextVersion}`;
    const introduction =
      request.personalized_intro?.trim() ||
      `Thank you for your interest in ${request.project_name}. This information pack was prepared for ${lead?.full_name ?? "the prospective buyer"} based on the information requested.`;
    const includePlans = requestTopicRows.some((topic) => topic.code === "payment_plans" || topic.code === "pricing");
    const snapshot: InformationPackSnapshot = {
      company: {
        company_name: company.company_name,
        logo_url: company.logo_url,
        contact_email: company.contact_email,
        phone_number: company.phone_number,
        website: company.website,
        location_address: company.location_address,
        short_description: company.short_description,
      },
      project: {
        name: request.project_name,
        description: company.short_description,
        location: company.location_address,
      },
      recipient: {
        name: lead?.full_name ?? "Prospective buyer",
        email: lead?.email ?? null,
        phone: lead?.phone ?? null,
      },
      selected_lot: selectedLot,
      availability: {
        available_count: availableLots.length,
        minimum_price: availablePrices.length ? Math.min(...availablePrices) : null,
        maximum_price: availablePrices.length ? Math.max(...availablePrices) : null,
      },
      topics: requestTopicRows.map((topic) => ({
        code: topic.code,
        name: topic.name,
        description: topic.description,
        content: topic.default_content,
      })),
      payment_plans: includePlans
        ? (plans ?? []).map((plan) => ({
            id: plan.id,
            name: plan.name,
            description: plan.description,
            reservation_fee: plan.reservation_fee,
            initial_deposit: plan.initial_deposit,
            final_purchase_price: plan.final_purchase_price,
            term_months: plan.term_months,
            monthly_payment: plan.monthly_payment,
          }))
        : [],
      custom_request: request.custom_request,
      next_step: selectedLot
        ? `Contact ${companyName} to confirm Lot ${selectedLot.lot_number}, current pricing, and the appropriate next step.`
        : `Contact ${companyName} to confirm current availability and identify the most suitable next step.`,
      generated_at: new Date().toISOString(),
    };

    const currentPacks = request.information_packs ?? [];
    const approvedPacks = currentPacks.filter((pack) => pack.status === "approved");
    if (approvedPacks.length > 0) {
      const { error: supersedeError } = await supabase
        .from("information_packs")
        .update({ status: "superseded" })
        .in(
          "id",
          approvedPacks.map((pack) => pack.id),
        );
      if (supersedeError) {
        setSaving(null);
        return setActionError(supersedeError.message);
      }
    }

    const { data: pack, error: packError } = await supabase
      .from("information_packs")
      .insert({
        request_id: request.id,
        version: nextVersion,
        document_number: documentNumber,
        title: `${request.project_name} Information Pack`,
        introduction,
        content_snapshot: snapshot,
        generated_by: userId,
      })
      .select("id")
      .single();
    if (packError) {
      setSaving(null);
      return setActionError(packError.message);
    }

    const { error: requestError } = await supabase
      .from("information_requests")
      .update({ status: "draft_generated", communication_status: "action_required" })
      .eq("id", request.id);
    if (requestError) {
      setSaving(null);
      return setActionError(requestError.message);
    }

    await supabase.from("lead_activities").insert({
      lead_id: request.lead_id,
      activity_type: "note",
      title: "Information pack draft generated",
      description: `${documentNumber} generated for staff review.`,
      metadata: { information_request_id: request.id, information_pack_id: pack.id, version: nextVersion },
      created_by: userId,
    });

    setSaving(null);
    setMessage("Draft generated. Review the printable preview before approval.");
    await refreshInformationData(queryClient);
  }

  async function moveToReview(request: InformationRequest) {
    await updateRequestWorkflow(request.id, { status: "ready_for_review" }, "Pack marked ready for review.");
  }

  async function approveRequest(request: InformationRequest) {
    const pack = latestInformationPack(request.information_packs);
    if (!pack) return setActionError("Generate a draft before approval.");
    setActionError(null);
    setMessage(null);
    setSaving(`approve-${request.id}`);
    const userId = sessionProfile?.session?.user.id ?? null;
    const approvedAt = new Date().toISOString();
    const { error: packError } = await supabase
      .from("information_packs")
      .update({ status: "approved", approved_by: userId, approved_at: approvedAt })
      .eq("id", pack.id);
    if (packError) {
      setSaving(null);
      return setActionError(packError.message);
    }
    const { error: requestError } = await supabase
      .from("information_requests")
      .update({ status: "approved", approved_by: userId, approved_at: approvedAt })
      .eq("id", request.id);
    setSaving(null);
    if (requestError) return setActionError(requestError.message);
    setMessage("Information pack approved. It is ready to download and send manually.");
    await refreshInformationData(queryClient);
  }

  async function markSent(request: InformationRequest) {
    const pack = latestInformationPack(request.information_packs);
    if (!pack || pack.status !== "approved") return setActionError("Approve the latest pack before marking it sent.");
    setActionError(null);
    setMessage(null);
    setSaving(`sent-${request.id}`);
    const userId = sessionProfile?.session?.user.id ?? null;
    const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const topicNames = requestTopics(request).map((topic) => topic.name).join(", ");
    const { data: task, error: taskError } = await supabase
      .from("follow_up_tasks")
      .insert({
        lead_id: request.lead_id,
        title: "Follow up after information pack",
        description: `Confirm receipt of ${pack.document_number}, answer questions, and propose the next action. Topics sent: ${topicNames || "Custom information"}.`,
        due_at: dueAt,
        status: "open",
        priority: "normal",
        assigned_to: request.assigned_to,
        created_by: userId,
      })
      .select("id")
      .single();
    if (taskError) {
      setSaving(null);
      return setActionError(taskError.message);
    }

    const sentAt = new Date().toISOString();
    const { error: requestError } = await supabase
      .from("information_requests")
      .update({
        status: "sent",
        communication_status: "waiting_for_customer",
        sent_at: sentAt,
        sent_by: userId,
        sent_channel: sentChannel,
        follow_up_task_id: task.id,
      })
      .eq("id", request.id);
    if (requestError) {
      setSaving(null);
      return setActionError(requestError.message);
    }

    const activityType = sentChannel === "Email" ? "email" : sentChannel === "WhatsApp" ? "whatsapp" : "note";
    const { error: activityError } = await supabase.from("lead_activities").insert({
      lead_id: request.lead_id,
      activity_type: activityType,
      title: "Information pack sent",
      description: `${pack.document_number} marked sent by ${sentChannel}. Follow-up due ${formatDate(dueAt)}.`,
      metadata: {
        information_request_id: request.id,
        information_pack_id: pack.id,
        document_number: pack.document_number,
        sent_channel: sentChannel,
        follow_up_task_id: task.id,
      },
      created_by: userId,
    });
    setSaving(null);
    if (activityError) return setActionError(activityError.message);
    setMessage("Pack marked sent and a follow-up task was created for two days from now.");
    await refreshInformationData(queryClient);
  }

  async function updateRequestWorkflow(
    requestId: string,
    updates: Partial<Pick<InformationRequest, "status" | "communication_status">>,
    successMessage: string,
  ) {
    setActionError(null);
    setMessage(null);
    setSaving(`workflow-${requestId}`);
    const { error } = await supabase.from("information_requests").update(updates).eq("id", requestId);
    setSaving(null);
    if (error) return setActionError(error.message);
    setMessage(successMessage);
    await refreshInformationData(queryClient);
  }

  async function copyText(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
      setActionError(null);
    } catch {
      setActionError("Copy failed. Select the text manually and copy it.");
    }
  }

  const emailSubject = selectedRequest ? buildEmailSubject(selectedRequest) : "";
  const emailMessage = selectedRequest ? buildEmailMessage(selectedRequest, latestPack, companyName) : "";
  const shortMessage = selectedRequest ? buildShortMessage(selectedRequest, latestPack, companyName) : "";

  return (
    <div>
      <PageHeader
        title="Information Centre"
        description="Create, review, download, and record branded information packs without sending customer messages automatically."
        action={
          canWrite ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New Information Request
            </Button>
          ) : null
        }
      />

      <div className="crm-info-panel mb-5 p-4 text-sm">
        The Information Centre coordinates the workflow. Staff still verify the recipient, pricing, lot availability, document content, and message before manually sending anything.
      </div>
      {message ? <div className="crm-success-panel mb-4 p-3 text-sm">{message}</div> : null}
      {actionError ? <div className="mb-4"><ErrorState message={actionError} /></div> : null}
      {requestsLoading || topicsLoading || leadsLoading ? <LoadingState /> : null}
      {requestsError ? <ErrorState message={(requestsError as Error).message} /> : null}

      {!requestsLoading && !requestsError ? (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.7fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Information Requests</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {(requests ?? []).length === 0 ? (
                <EmptyState title="No information requests" description="Create a request from an interested lead to begin the workflow." />
              ) : null}
              {(requests ?? []).map((request) => {
                const requestLead = request.leads;
                const active = selectedRequest?.id === request.id;
                return (
                  <button
                    key={request.id}
                    type="button"
                    onClick={() => setSelectedRequestId(request.id)}
                    className={`focus-ring w-full rounded-lg border p-4 text-left transition ${
                      active ? "border-primary bg-primary-soft shadow-sm" : "bg-card hover:border-primary/30 hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-primary">{requestLead?.full_name ?? "Unknown lead"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{request.project_name}</p>
                      </div>
                      <Badge tone={requestStatusTones[request.status]}>{requestStatusLabels[request.status]}</Badge>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {requestTopics(request).map((topic) => topic.name).join(", ") || request.custom_request || "No topics recorded"}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">Updated {formatDate(request.updated_at)}</p>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <div className="min-w-0">
            {!selectedRequest ? (
              <Card>
                <CardContent className="p-8">
                  <EmptyState title="Select an information request" description="Choose a request to review its topics, generated versions, and next action." />
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-5">
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle>{selectedRequest.leads?.full_name ?? "Information Request"}</CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">{selectedRequest.project_name}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge tone={requestStatusTones[selectedRequest.status]}>{requestStatusLabels[selectedRequest.status]}</Badge>
                        <Badge tone={selectedRequest.communication_status === "waiting_for_customer" ? "amber" : "blue"}>
                          {communicationStatusLabels[selectedRequest.communication_status]}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <Summary label="Lead" value={selectedRequest.leads?.full_name ?? "Unknown"} />
                      <Summary label="Selected lot" value={selectedRequest.parcels ? `Lot ${selectedRequest.parcels.lot_number}` : "Not selected"} />
                      <Summary label="Requested" value={formatDate(selectedRequest.requested_at)} />
                      <Summary label="Assigned" value={selectedRequest.assigned_to ? "Assigned staff member" : "Unassigned"} />
                      <Summary label="Sent channel" value={selectedRequest.sent_channel ?? "Not sent"} />
                      <Summary label="Follow-up" value={selectedRequest.follow_up_task_id ? "Task created" : "Not created"} />
                    </div>

                    <section>
                      <h3 className="text-sm font-semibold text-primary">Requested information</h3>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedRequestTopics.map((topic) => <Badge key={topic.id} tone="brown">{topic.name}</Badge>)}
                        {selectedRequestTopics.length === 0 ? <span className="text-sm text-muted-foreground">No standard topics selected.</span> : null}
                      </div>
                      {selectedRequest.custom_request ? (
                        <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
                          <span className="font-medium text-primary">Custom request:</span> {selectedRequest.custom_request}
                        </div>
                      ) : null}
                    </section>

                    <div className="flex flex-wrap gap-2 border-t pt-4">
                      {canWrite && ["requested", "needs_revision"].includes(selectedRequest.status) ? (
                        <Button type="button" onClick={() => void generateDraft(selectedRequest)} disabled={Boolean(saving)}>
                          <Sparkles className="h-4 w-4" />
                          {saving === `generate-${selectedRequest.id}` ? "Generating..." : "Generate Draft"}
                        </Button>
                      ) : null}
                      {canWrite && selectedRequest.status === "draft_generated" ? (
                        <Button type="button" onClick={() => void moveToReview(selectedRequest)} disabled={Boolean(saving)}>
                          <FileCheck2 className="h-4 w-4" />
                          Ready for Review
                        </Button>
                      ) : null}
                      {canWrite && selectedRequest.status === "ready_for_review" ? (
                        <Button type="button" onClick={() => void approveRequest(selectedRequest)} disabled={Boolean(saving)}>
                          <Check className="h-4 w-4" />
                          {saving === `approve-${selectedRequest.id}` ? "Approving..." : "Approve Pack"}
                        </Button>
                      ) : null}
                      {latestPack ? (
                        <Link to={`/information-packs/${latestPack.id}/print`} target="_blank" rel="noreferrer">
                          <Button type="button" variant="outline">
                            <FileText className="h-4 w-4" />
                            Preview / Save PDF
                          </Button>
                        </Link>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>

                {latestPack ? (
                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <CardTitle>Latest Generated Pack</CardTitle>
                          <p className="mt-1 text-sm text-muted-foreground">{latestPack.document_number} · Version {latestPack.version}</p>
                        </div>
                        <Badge tone={latestPack.status === "approved" ? "green" : latestPack.status === "superseded" ? "gray" : "brown"}>
                          {labelize(latestPack.status)}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                      <p className="text-sm leading-6 text-muted-foreground">{latestPack.introduction}</p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Summary label="Available lots" value={String(latestPack.content_snapshot.availability.available_count)} />
                        <Summary
                          label="Price range"
                          value={formatPriceRange(
                            latestPack.content_snapshot.availability.minimum_price,
                            latestPack.content_snapshot.availability.maximum_price,
                          )}
                        />
                        <Summary label="Payment plans" value={String(latestPack.content_snapshot.payment_plans.length)} />
                      </div>
                      <div className="grid gap-3">
                        {latestPack.content_snapshot.topics.map((topic) => (
                          <div key={topic.code} className="rounded-md border p-4">
                            <p className="font-semibold text-primary">{topic.name}</p>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{topic.content}</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}

                {selectedRequest.status === "approved" && latestPack?.status === "approved" ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Manual Sending</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                      <div className="crm-warning-panel p-4 text-sm">
                        Download the approved PDF, review the recipient and message, send it through the chosen business channel, and only then mark it sent.
                      </div>
                      <div className="grid gap-3 lg:grid-cols-[180px_1fr]">
                        <Field label="Channel used">
                          <Select value={sentChannel} onChange={(event) => setSentChannel(event.target.value)}>
                            <option>Email</option>
                            <option>WhatsApp</option>
                            <option>SMS</option>
                            <option>Messenger</option>
                            <option>Other</option>
                          </Select>
                        </Field>
                        <div className="flex flex-wrap items-end gap-2">
                          <Button type="button" variant="outline" onClick={() => void copyText(emailSubject, "Email subject copied.")}>
                            <Clipboard className="h-4 w-4" />
                            Copy Subject
                          </Button>
                          <Button type="button" variant="outline" onClick={() => void copyText(emailMessage, "Email message copied.")}>
                            <Mail className="h-4 w-4" />
                            Copy Email
                          </Button>
                          <Button type="button" variant="outline" onClick={() => void copyText(shortMessage, "Short message copied.")}>
                            <Clipboard className="h-4 w-4" />
                            Copy Short Message
                          </Button>
                          {canWrite ? (
                            <Button type="button" onClick={() => void markSent(selectedRequest)} disabled={Boolean(saving)}>
                              <Send className="h-4 w-4" />
                              {saving === `sent-${selectedRequest.id}` ? "Saving..." : "Mark Sent & Create Follow-Up"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4">
          <div className="my-6 w-full max-w-3xl rounded-lg border bg-card shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b p-5">
              <div>
                <h2 className="font-display text-2xl font-semibold text-primary">New Information Request</h2>
                <p className="mt-1 text-sm text-muted-foreground">Record exactly what the interested buyer asked to receive.</p>
              </div>
              <Button type="button" variant="ghost" className="h-9 px-3" onClick={() => setCreateOpen(false)}>
                <X className="h-4 w-4" />
                Close
              </Button>
            </div>
            <form className="grid gap-5 p-5" onSubmit={(event) => void createRequest(event)}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Lead">
                  <Select value={leadId} onChange={(event) => {
                    const nextLeadId = event.target.value;
                    setLeadId(nextLeadId);
                    const lead = leads?.find((row) => row.id === nextLeadId);
                    if (lead?.assigned_to) setMessage(null);
                  }} required>
                    <option value="">Select a lead</option>
                    {(leads ?? []).map((lead) => <option key={lead.id} value={lead.id}>{lead.full_name}</option>)}
                  </Select>
                </Field>
                <Field label="Project name">
                  <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} required />
                </Field>
                <Field label="Specific lot (optional)">
                  <Select value={parcelId} onChange={(event) => setParcelId(event.target.value)}>
                    <option value="">No specific lot selected</option>
                    {(parcels ?? []).map((parcel) => (
                      <option key={parcel.id} value={parcel.id}>Lot {parcel.lot_number} · {parcel.status} · {money(parcel.base_price)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Personalized opening (optional)">
                  <Input value={personalizedIntro} onChange={(event) => setPersonalizedIntro(event.target.value)} placeholder="Thank you for your interest..." />
                </Field>
              </div>

              <section>
                <p className="text-sm font-semibold text-primary">Requested information</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {(topics ?? []).map((topic) => {
                    const checked = selectedTopicIds.includes(topic.id);
                    return (
                      <label key={topic.id} className={`flex cursor-pointer gap-3 rounded-md border p-3 transition ${checked ? "border-primary bg-primary-soft" : "hover:border-primary/30"}`}>
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4"
                          checked={checked}
                          onChange={() => setSelectedTopicIds((current) => checked ? current.filter((id) => id !== topic.id) : [...current, topic.id])}
                        />
                        <span>
                          <span className="block text-sm font-semibold text-primary">{topic.name}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{topic.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>

              <Field label="Custom request or staff note (optional)">
                <Textarea value={customRequest} onChange={(event) => setCustomRequest(event.target.value)} placeholder="Record information that does not fit the standard topics." />
              </Field>

              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={saving === "create"}>
                  <FilePlus2 className="h-4 w-4" />
                  {saving === "create" ? "Creating..." : "Create Request"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-copper">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-primary">{value}</p>
    </div>
  );
}

function requestTopics(request: InformationRequest) {
  return (request.information_request_topics ?? [])
    .map((row) => row.information_topics)
    .filter((topic): topic is InformationTopic => Boolean(topic))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

function latestInformationPack(packs: InformationPack[] | undefined) {
  return [...(packs ?? [])].sort((a, b) => b.version - a.version)[0] ?? null;
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPriceRange(minimum: number | null, maximum: number | null) {
  if (minimum === null || maximum === null) return "Not available";
  if (minimum === maximum) return money(minimum);
  return `${money(minimum)} – ${money(maximum)}`;
}

function buildEmailSubject(request: InformationRequest) {
  return `${request.project_name} information requested`;
}

function buildEmailMessage(request: InformationRequest, pack: InformationPack | null, companyName: string) {
  const leadName = request.leads?.full_name ?? "there";
  const topics = requestTopics(request).map((topic) => topic.name).join(", ") || "the information you requested";
  return [
    `Hi ${firstName(leadName)},`,
    "",
    `Thank you for your interest in ${request.project_name}. I have prepared the requested information about ${topics}.`,
    pack ? `Please review the attached information pack (${pack.document_number}).` : "Please review the attached information pack.",
    "",
    "After reviewing it, let us know whether you would like to confirm a particular lot, arrange a site visit, or discuss a suitable payment option.",
    "",
    `Best,\n${companyName}`,
  ].join("\n");
}

function buildShortMessage(request: InformationRequest, pack: InformationPack | null, companyName: string) {
  const leadName = request.leads?.full_name ?? "there";
  return `Hi ${firstName(leadName)}, thank you for your interest in ${request.project_name}. Your requested information${pack ? ` (${pack.document_number})` : ""} is ready. Please review the attached pack and let ${companyName} know whether you would like to discuss a specific lot, payment option, or site visit.`;
}

function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || "there";
}

async function refreshInformationData(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["information-requests"] }),
    queryClient.invalidateQueries({ queryKey: ["sales-lead-activities"] }),
    queryClient.invalidateQueries({ queryKey: ["sales-follow-up-tasks"] }),
  ]);
}
