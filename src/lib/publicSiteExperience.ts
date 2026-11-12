import { useQuery } from "@tanstack/react-query";
import {
  defaultPublicExperience,
  normalizePublicExperience,
  type PublicExperienceConfig,
  type PublicExperienceScope,
} from "./publicExperience.mjs";
import { hasSupabaseConfig } from "./supabase";

const endpoint = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export type PublicResolvedScope = PublicExperienceScope & { hostname: string };
export type PublicPhaseOption = { slug: string; name: string };
export type PublicSiteData = {
  scope: PublicExperienceScope;
  siteExperience: PublicExperienceConfig;
  phases: PublicPhaseOption[];
  company: {
    company_name: string;
    logo_url: string;
    short_description: string;
    contact_email: string;
    phone_number: string;
    location_address: string;
    website: string;
  };
  publicApplication: {
    applications_open: boolean;
    notices_complete: boolean;
    public_notice_text: string;
    application_acknowledgment_text: string;
    default_confirmation_message: string;
    show_lot_prices_publicly: boolean;
    show_available_lot_count_publicly: boolean;
  };
  installmentPlans: Array<Record<string, unknown>>;
  paymentMethods: Array<Record<string, unknown>>;
};

async function loadPublicSiteExperience(
  hostname: string,
  binding: { tenantSlug: string; projectSlug: string; phaseSlug: string | null },
  requestedPhaseSlug: string | null,
): Promise<PublicSiteData> {
  if (!endpoint || !anonKey) throw new Error("Public project information is not configured.");
  const params = new URLSearchParams({ host: hostname });
  if (requestedPhaseSlug !== null) params.set("phase", requestedPhaseSlug);
  const response = await fetch(`${endpoint}/functions/v1/get-public-site-experience?${params}`, {
    method: "GET",
    headers: { apikey: anonKey, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as {
    scope?: PublicExperienceScope;
    siteExperience?: unknown;
    phases?: unknown;
    company?: unknown;
    publicApplication?: unknown;
    installmentPlans?: unknown;
    paymentMethods?: unknown;
    error?: string;
  };
  const siteExperience = isRecord(body.siteExperience) ? body.siteExperience : null;
  const applicationType = siteExperience?.applicationType;
  if (!response.ok || body.scope?.tenantSlug !== binding.tenantSlug
    || body.scope?.projectSlug !== binding.projectSlug
    || (requestedPhaseSlug !== null && body.scope?.phaseSlug !== requestedPhaseSlug)
    || (applicationType !== "land_purchase" && applicationType !== "project_application")
    || !Array.isArray(body.phases) || !isRecord(body.company) || !isRecord(body.publicApplication)) {
    throw new Error(body.error || "Public project scope could not be verified.");
  }
  return {
    scope: body.scope,
    siteExperience: normalizePublicExperience(body.scope, body.siteExperience),
    phases: body.phases.filter(isPhaseOption),
    company: body.company as PublicSiteData["company"],
    publicApplication: body.publicApplication as PublicSiteData["publicApplication"],
    installmentPlans: Array.isArray(body.installmentPlans) ? body.installmentPlans.filter(isRecord) : [],
    paymentMethods: Array.isArray(body.paymentMethods) ? body.paymentMethods.filter(isRecord) : [],
  };
}

export function usePublicSiteExperience(
  hostname: string,
  binding: { tenantSlug: string; projectSlug: string; phaseSlug: string | null },
  requestedPhaseSlug: string | null,
  allow = true,
) {
  return useQuery({
    queryKey: ["public-site-experience", hostname, binding.tenantSlug, binding.projectSlug, requestedPhaseSlug ?? "default"],
    queryFn: () => loadPublicSiteExperience(hostname, binding, requestedPhaseSlug),
    enabled: allow && hasSupabaseConfig && Boolean(hostname && binding.tenantSlug && binding.projectSlug),
    staleTime: 0,
    retry: false,
  });
}

export { defaultPublicExperience };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPhaseOption(value: unknown): value is PublicPhaseOption {
  return isRecord(value) && typeof value.slug === "string" && typeof value.name === "string";
}
