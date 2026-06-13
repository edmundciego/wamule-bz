import { supabase } from "./supabase";
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

export async function approveApplication(applicationId: number, parcelId: number) {
  const { error } = await supabase.rpc("approve_application", {
    p_application_id: applicationId,
    p_parcel_id: parcelId,
  });
  if (error) throw error;
}

export async function updateApplicationStatus(id: number, status: ApplicationStatus, parcelId?: number) {
  if (status === "Approved") {
    if (!parcelId) throw new Error("Select an available lot before approving this application.");
    return approveApplication(id, parcelId);
  }
  const { error } = await supabase.from("applications").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function checkDuplicateBankReference(bankReference: string) {
  const cleaned = bankReference.trim().toUpperCase();
  if (!cleaned) return false;
  const { data, error } = await supabase
    .from("transactions")
    .select("id")
    .eq("bank_reference", cleaned)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
