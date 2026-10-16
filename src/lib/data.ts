import { supabase } from "./supabase";
import { isAvailableForSalesSelection } from "../../supabase/functions/_shared/parcel-provenance.mjs";
import type { ApplicationStatus } from "../types/database";

export async function getSessionAndProfile() {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session) return { session: null, profile: null };

  const { data: profile, error } = await supabase
    .from("admin_profiles")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  return { session, profile };
}

export async function approveApplication(applicationId: number, parcelId: number, tenantId: string, projectId: string, phaseId: string, allowLegacyUnscoped = false) {
  if (!tenantId || !projectId || !phaseId) throw new Error("Choose a workspace before approving an application.");
  let applicationQuery = supabase.from("applications").select("id,application_kind").eq("id", applicationId).eq("tenant_id", tenantId);
  if (allowLegacyUnscoped) {
    applicationQuery = applicationQuery.or(`and(project_id.eq.${projectId},phase_id.eq.${phaseId}),and(project_id.is.null,phase_id.is.null)`);
  } else {
    applicationQuery = applicationQuery.eq("project_id", projectId).eq("phase_id", phaseId);
  }
  const [{ data: application, error: applicationError }, { data: parcel, error: parcelError }] = await Promise.all([
    applicationQuery.maybeSingle(),
    supabase.from("parcels").select("id, status, geometry_source, needs_review").eq("id", parcelId).eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId).maybeSingle(),
  ]);
  if (applicationError) throw applicationError;
  if (parcelError) throw parcelError;
  if (!application) throw new Error("This application is outside the selected tenant workspace.");
  if (application.application_kind === "project_application") throw new Error("A Hopkins project application has no allocated parcel and cannot be approved as a lot purchase.");
  if (!parcel || !isAvailableForSalesSelection(parcel)) throw new Error("Choose an available existing inventory record from the selected project and phase.");
  const { error } = await supabase.rpc("approve_application", {
    p_application_id: applicationId,
    p_parcel_id: parcelId,
  });
  if (error) throw error;
}

export async function updateApplicationStatus(id: number, status: ApplicationStatus, tenantId: string, projectId: string, phaseId: string, parcelId?: number, allowLegacyUnscoped = false) {
  if (status === "Approved") {
    if (!parcelId) throw new Error("Select an available lot before approving this application.");
    return approveApplication(id, parcelId, tenantId, projectId, phaseId, allowLegacyUnscoped);
  }
  if (!tenantId) throw new Error("Choose a workspace before updating an application.");
  let query = supabase.from("applications").update({ status }).eq("id", id).eq("tenant_id", tenantId);
  if (allowLegacyUnscoped) {
    query = query.or(`and(project_id.eq.${projectId},phase_id.eq.${phaseId}),and(project_id.is.null,phase_id.is.null)`);
  } else {
    query = query.eq("project_id", projectId).eq("phase_id", phaseId);
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This application is outside the selected tenant workspace.");
}

export async function checkDuplicateBankReference(bankReference: string, tenantId: string) {
  const cleaned = bankReference.trim().toUpperCase();
  if (!cleaned) return false;
  if (!tenantId) throw new Error("Choose a workspace before checking payment references.");
  const { data, error } = await supabase
    .from("transactions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("bank_reference", cleaned)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
