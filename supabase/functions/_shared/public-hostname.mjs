export function normalizePublicHostname(value) {
  if (typeof value !== "string" || /[^\x00-\x7F]/.test(value)) return null;
  let hostname = value.replace(/^ +| +$/g, "").toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (
    hostname.length > 253
    || /^[0-9.]+$/.test(hostname)
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) return null;
  return hostname;
}

const allowedReasons = new Set([
  "invalid_hostname",
  "unknown_host",
  "pending_verification",
  "awaiting_activation",
  "inactive_binding",
  "stale_verification",
  "inactive_or_ineligible_target",
]);

function validSlug(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,78}$/.test(value);
}

/** Parse only the route-safe public projection returned by resolve_public_hostname. */
export function parsePublicHostnameResolution(data) {
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  if (rows.length !== 1) return { resolved: false, reason: "resolver_unavailable" };
  const row = rows[0];
  if (row?.resolution === "resolved"
    && validSlug(row.tenant_slug)
    && validSlug(row.project_slug)
    && (row.phase_slug === null || validSlug(row.phase_slug))) {
    return {
      resolved: true,
      scope: {
        tenantSlug: row.tenant_slug,
        projectSlug: row.project_slug,
        phaseSlug: row.phase_slug,
      },
    };
  }
  if (row?.resolution === "unresolved" && allowedReasons.has(row.reason)) {
    return { resolved: false, reason: row.reason };
  }
  return { resolved: false, reason: "resolver_unavailable" };
}

function normalizeTxtAnswer(data) {
  return String(data ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
}

export async function verifyDnsTxtHostname(hostname, challenge, {
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const normalized = normalizePublicHostname(hostname);
  if (!normalized || typeof challenge !== "string" || !/^[0-9a-f-]{36}$/i.test(challenge)) {
    throw new Error("Invalid hostname verification challenge.");
  }
  const recordName = `_wamule-verification.${normalized}`;
  const url = new URL("https://dns.google/resolve");
  url.searchParams.set("name", recordName);
  url.searchParams.set("type", "TXT");
  const response = await fetchImpl(url, {
    headers: { accept: "application/dns-json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("DNS verification lookup failed.");
  const payload = await response.json();
  const expected = `wamule-host-verification=${challenge}`;
  const matched = Array.isArray(payload?.Answer)
    && payload.Answer.some((answer) => Number(answer?.type) === 16 && normalizeTxtAnswer(answer?.data) === expected);
  if (payload?.Status !== 0 || !matched) throw new Error("DNS verification challenge was not found.");
  return {
    hostname: normalized,
    challenge,
    method: "dns_txt",
    provider: "Google Public DNS over HTTPS",
    verification_result: "passed",
    server_validated: true,
    checked_at: now().toISOString(),
  };
}

export async function verifyNetlifyDefaultHostname(hostname, challenge, {
  siteId,
  authToken,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const normalized = normalizePublicHostname(hostname);
  if (!normalized || !normalized.endsWith(".netlify.app")
    || typeof challenge !== "string" || !/^[0-9a-f-]{36}$/i.test(challenge)
    || !siteId || !authToken) {
    throw new Error("Netlify hostname verification is not configured for this challenge.");
  }
  const response = await fetchImpl(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`, {
    headers: { authorization: `Bearer ${authToken}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Netlify site verification lookup failed.");
  const site = await response.json();
  if (site?.id !== siteId || `${String(site?.name ?? "").toLowerCase()}.netlify.app` !== normalized) {
    throw new Error("Hostname is not the configured Netlify default domain.");
  }
  return {
    hostname: normalized,
    challenge,
    method: "netlify_site_api",
    provider: "Netlify Sites API",
    verification_result: "passed",
    server_validated: true,
    checked_at: now().toISOString(),
  };
}
