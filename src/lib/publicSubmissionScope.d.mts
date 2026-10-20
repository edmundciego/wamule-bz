export function isLocalOnlySubmissionForScope(input: {
  isDev: boolean;
  demoMode?: string;
  tenantSlug?: string;
  projectSlug?: string;
  stagingSubmissionScopes?: string[];
}): boolean;
