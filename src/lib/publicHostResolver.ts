import { parsePublicHostnameResolution, normalizePublicHostname } from "../../supabase/functions/_shared/public-hostname.mjs";
import { supabase } from "./supabase";

export type { PublicHostnameResolution } from "../../supabase/functions/_shared/public-hostname.mjs";

/** Route-only lookup. Errors and unknown hosts never fall back to Wamule or a CRM scope. */
export async function resolvePublicHostname(hostnameInput: string) {
  const hostname = normalizePublicHostname(hostnameInput);
  if (!hostname) return { resolved: false, reason: "invalid_hostname" } as const;

  const { data, error } = await supabase.rpc("resolve_public_hostname", { p_hostname: hostname });
  if (error) return { resolved: false, reason: "resolver_unavailable" } as const;
  return parsePublicHostnameResolution(data);
}
