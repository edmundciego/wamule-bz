import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile, updateApplicationStatus } from "../lib/data";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/utils";
import type { ApplicationAiReview, ApplicationStatus, AppRole } from "../types/database";

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

  function preferredLotText(preferredParcelIds: unknown) {
    if (!Array.isArray(preferredParcelIds) || !lotOptions) return "None listed";
    const labels = preferredParcelIds
      .map((id) => lotOptions.find((lot) => lot.id === Number(id))?.lot_number ?? String(id))
      .map((lotNumber) => `Lot ${lotNumber}`);
    return labels.length > 0 ? labels.join(", ") : "None listed";
  }

  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canGenerateAiReview = currentRole === "Super Admin" || currentRole === "Admin";
  const aiReviewEnabled = Boolean(aiSettings?.is_enabled && aiSettings.application_summary_enabled);

  return (
    <>
      <PageHeader title="Applications" description="Review intake applications and approve qualifying applicants." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {actionError ? <div className="mb-4"><ErrorState message={actionError} /></div> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {statuses.map((status) => (
          <section key={status} className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">{status}</h2>
              <Badge tone={status === "Approved" ? "green" : status === "Declined" ? "red" : "amber"}>
                {data?.filter((item) => item.status === status).length ?? 0}
              </Badge>
            </div>
            <div className="grid gap-3">
              {data
                ?.filter((item) => item.status === status)
                .map((application) => (
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
                        {status !== "Declined" ? <Button type="button" variant="secondary" onClick={() => void setStatus(application.id, "Declined")}>Decline</Button> : null}
                      </div>
                    </CardContent>
                  </Card>
                ))}
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
    <div className="grid gap-3 rounded-md border border-primary/10 bg-ivory/45 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-primary">AI Application Review</p>
          <p className="text-xs text-muted-foreground">Assistant-generated review guidance only. Admin remains responsible for final decisions.</p>
        </div>
        {review ? <Badge tone={reviewTone(review.completeness_status)}>{review.completeness_status}</Badge> : <Badge tone="gray">Not generated</Badge>}
      </div>

      {!aiReviewEnabled ? (
        <p className="rounded-md border border-copper/25 bg-copper/10 p-2 text-xs text-copper">
          AI Application Review is not enabled. Enable it in Settings.
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
        <p className="text-xs text-muted-foreground">No assistant review has been generated for this application yet.</p>
      )}

      {canGenerate ? (
        <div className="flex justify-end">
          <Button type="button" variant="secondary" disabled={generating} onClick={onGenerate}>
            {generating ? "Generating..." : review ? "Regenerate Review" : "Generate AI Review"}
          </Button>
        </div>
      ) : null}
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
