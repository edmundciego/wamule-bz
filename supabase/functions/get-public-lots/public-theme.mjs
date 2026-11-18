const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Accept only the public Storage CSS asset shape emitted by tenant-publish.
 * Arbitrary database URLs must not become stylesheet requests in an embed.
 */
export function safeTenantThemeCssUrl(value, supabaseUrl, tenantId) {
  if (typeof value !== "string" || !value || typeof tenantId !== "string" || !tenantId) return null;
  try {
    const base = new URL(supabaseUrl);
    const target = new URL(value);
    if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) return null;
    const isHttps = base.protocol === "https:" && target.protocol === "https:";
    const isLocalHttp = base.protocol === "http:" && target.protocol === "http:" && LOCAL_HOSTS.has(base.hostname);
    if (!isHttps && !isLocalHttp) return null;

    const parts = target.pathname.split("/");
    if (parts.length !== 8 || parts.slice(0, 6).join("/") !== "/storage/v1/object/public/business-assets") return null;
    if (decodeURIComponent(parts[6]) !== tenantId) return null;
    const filename = decodeURIComponent(parts[7]);
    if (!/^theme-[0-9]+\.css$/.test(filename)) return null;
    return target.href;
  } catch {
    return null;
  }
}
