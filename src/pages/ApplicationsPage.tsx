import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { updateApplicationStatus } from "../lib/data";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/utils";
import type { ApplicationStatus } from "../types/database";

const statuses: ApplicationStatus[] = ["Pending Review", "Approved", "Declined"];

export function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [selectedLots, setSelectedLots] = useState<Record<number, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["applications-kanban"],
    queryFn: async () => {
      const { data: applications, error: queryError } = await supabase
        .from("applications")
        .select("*, parcels(id, lot_number, status)")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return applications;
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

  function preferredLotText(preferredParcelIds: unknown) {
    if (!Array.isArray(preferredParcelIds) || !lotOptions) return "None listed";
    const labels = preferredParcelIds
      .map((id) => lotOptions.find((lot) => lot.id === Number(id))?.lot_number ?? String(id))
      .map((lotNumber) => `Lot ${lotNumber}`);
    return labels.length > 0 ? labels.join(", ") : "None listed";
  }

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
