/**
 * Read a role claim from a JWT already signature-verified by the Supabase
 * Edge gateway. This helper deliberately performs no signature verification.
 */
export function gatewayJwtHasRole(request, requiredRole, nowSeconds = Date.now() / 1000) {
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const parts = match[1].split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload));
    return claims.role === requiredRole && typeof claims.exp === "number" && claims.exp > nowSeconds;
  } catch {
    return false;
  }
}
