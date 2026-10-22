export const STAGING_PROJECT_REF = "kvocwmrcuhiaezlcgzjf";
export const STAGING_SUPABASE_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
export const STAGING_SUBMISSION_SCOPE =
  "map-studio-workflow-test/map-studio-import-qa";

export function createStagingBuildEnv(input) {
  const suppliedUrl = input.VITE_SUPABASE_URL?.trim();
  if (suppliedUrl && suppliedUrl !== STAGING_SUPABASE_URL) {
    throw new Error(
      "Staging build requires VITE_SUPABASE_URL for the verified staging project.",
    );
  }
  const anonKey = input.VITE_SUPABASE_ANON_KEY?.trim();
  if (!anonKey) {
    throw new Error(
      "Staging build requires the existing browser-safe Supabase anon key.",
    );
  }
  if (getJwtProjectRef(anonKey) !== STAGING_PROJECT_REF) {
    throw new Error(
      "The browser-safe Supabase anon key does not match the verified staging project.",
    );
  }

  return {
    ...input,
    VITE_SUPABASE_URL: STAGING_SUPABASE_URL,
    VITE_BUILD_ENV: "staging-preview",
    VITE_PUBLIC_DEMO_MODE: "true",
    VITE_PUBLIC_STAGING_SUBMISSION_SCOPES: STAGING_SUBMISSION_SCOPE,
  };
}

function getJwtProjectRef(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")).ref ?? null;
  } catch {
    return null;
  }
}
