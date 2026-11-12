export type PublicHostnameResolution =
  | { resolved: true; scope: { tenantSlug: string; projectSlug: string; phaseSlug: string | null } }
  | { resolved: false; reason: string };

export function normalizePublicHostname(value: unknown): string | null;
export function parsePublicHostnameResolution(data: unknown): PublicHostnameResolution;
export function verifyDnsTxtHostname(
  hostname: string,
  challenge: string,
  options?: { fetchImpl?: typeof fetch; now?: () => Date },
): Promise<Record<string, unknown>>;
export function verifyNetlifyDefaultHostname(
  hostname: string,
  challenge: string,
  options: { siteId: string; authToken: string; fetchImpl?: typeof fetch; now?: () => Date },
): Promise<Record<string, unknown>>;
