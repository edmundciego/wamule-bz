const DEFAULT_HOPKINS_PUBLIC_HOST = "hopkinsgrove.ceiba.bz";

/** Future custom-domain root mapping. The current staging host remains Wamule at /. */
export function isHopkinsPublicHost(hostname: string): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const configured = String(env?.VITE_HOPKINS_PUBLIC_HOST ?? DEFAULT_HOPKINS_PUBLIC_HOST)
    .trim()
    .toLowerCase();
  const normalized = hostname.trim().toLowerCase().replace(/:\d+$/, "");
  return normalized === configured;
}
