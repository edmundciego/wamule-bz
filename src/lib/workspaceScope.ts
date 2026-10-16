import type { AdminProfile } from "../types/database";
import type { WorkspaceChoice } from "../components/auth/workspaceScopeContext";

export type SavedWorkspaceSelection = Partial<Pick<WorkspaceChoice, "tenantId" | "projectId" | "phaseId">> | null;

export function workspaceScopeKey(workspace: WorkspaceChoice | null | undefined) {
  return workspace ? `${workspace.tenantId}:${workspace.projectId}:${workspace.phaseId}` : "unselected";
}

export function workspaceCompanyDefaults(tenantName?: string | null) {
  return {
    company_name: tenantName?.trim() ?? "",
    logo_url: "/favicon/android-chrome-192x192.png",
    contact_email: "",
    phone_number: "",
    website: "",
    location_address: "",
    short_description: "",
  };
}

export function workspaceApplicationDefaults(tenantName?: string | null) {
  const displayName = tenantName?.trim() || "the selected community";
  return {
    applications_open: true,
    public_notice_text: `Submission of this application is solely a request to be considered for the purchase of a lot within ${displayName}.`,
    application_acknowledgment_text: "By signing this application, I acknowledge and understand that submission does not guarantee approval or allocation of a lot.",
    show_lot_prices_publicly: true,
    show_available_lot_count_publicly: true,
    lot_map_tenant_slug: "",
    default_confirmation_message: `Application submitted. A ${displayName} representative will contact you after review.`,
  };
}

export function accessibleWorkspaceChoices(choices: WorkspaceChoice[], profile: AdminProfile | null) {
  if (!profile) return [];
  if (profile.role === "Super Admin") return choices;
  if (!profile.tenant_id) return [];
  return choices.filter((choice) => choice.tenantId === profile.tenant_id);
}

export function preferredWorkspace(choices: WorkspaceChoice[], saved: SavedWorkspaceSelection) {
  if (!choices.length) return null;
  const exact = choices.find((choice) => choice.tenantId === saved?.tenantId
    && choice.projectId === saved?.projectId && choice.phaseId === saved?.phaseId);
  if (exact) return exact;
  const tenant = choices.find((choice) => choice.tenantId === saved?.tenantId);
  if (tenant) return choices.find((choice) => choice.tenantId === tenant.tenantId
    && choice.isDefaultProject && choice.isDefaultPhase) ?? choices.find((choice) => choice.tenantId === tenant.tenantId) ?? null;
  return choices.find((choice) => choice.isDefaultProject && choice.isDefaultPhase) ?? choices[0] ?? null;
}
