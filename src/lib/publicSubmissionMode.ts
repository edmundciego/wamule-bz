import { isLocalOnlySubmissionForScope } from "./publicSubmissionScope.mjs";

const stagingSubmissionScopes = (import.meta.env.VITE_PUBLIC_STAGING_SUBMISSION_SCOPES ?? "")
  .split(",")
  .map((scope) => scope.trim().toLowerCase())
  .filter(Boolean);

/** Local development always stays local; staging demos stay local except for explicit QA scopes. */
export const isLocalOnlySubmission = isLocalOnlySubmissionForScope({
  isDev: import.meta.env.DEV,
  demoMode: import.meta.env.VITE_PUBLIC_DEMO_MODE,
  stagingSubmissionScopes: [],
});

export function isLocalOnlySubmissionForProject(tenantSlug: string, projectSlug?: string): boolean {
  return isLocalOnlySubmissionForScope({
    isDev: import.meta.env.DEV,
    demoMode: import.meta.env.VITE_PUBLIC_DEMO_MODE,
    tenantSlug,
    projectSlug: projectSlug ?? "",
    stagingSubmissionScopes,
  });
}
