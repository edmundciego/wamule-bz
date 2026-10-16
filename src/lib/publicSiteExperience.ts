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

async function loadPublicSiteExperience(scope: PublicExperienceScope): Promise<PublicExperienceConfig> {
  if (!endpoint || !anonKey) return defaultPublicExperience(scope);
  const params = new URLSearchParams({
    tenant: scope.tenantSlug,
    project: scope.projectSlug,
    phase: scope.phaseSlug,
  });
  const response = await fetch(`${endpoint}/functions/v1/get-public-site-experience?${params}`, {
    method: "GET",
    headers: { apikey: anonKey, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as {
    scope?: PublicExperienceScope;
    siteExperience?: unknown;
    error?: string;
  };
  if (!response.ok || body.scope?.tenantSlug !== scope.tenantSlug
    || body.scope?.projectSlug !== scope.projectSlug || body.scope?.phaseSlug !== scope.phaseSlug) {
    throw new Error(body.error || "Public site settings could not be verified.");
  }
  return normalizePublicExperience(scope, body.siteExperience);
}

export function usePublicSiteExperience(scope: PublicExperienceScope) {
  return useQuery({
    queryKey: ["public-site-experience", scope.tenantSlug, scope.projectSlug, scope.phaseSlug],
    queryFn: () => loadPublicSiteExperience(scope),
    enabled: hasSupabaseConfig,
    staleTime: 30_000,
    retry: false,
  });
}

export { defaultPublicExperience };
