export type PublicSubmissionScope = {
  tenantId: string;
  tenantSlug: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  mapExperienceMode: "sales" | "demo";
  phaseId: string;
  phaseSlug: string;
  phaseName: string;
};

export function resolvePublicSubmissionScope(
  client: any,
  input: {
    tenantSlug?: string | null;
    projectSlug?: string | null;
    phaseSlug?: string | null;
    hostname?: string | null;
    allowTenantAlias?: boolean;
  },
): Promise<{ ok: true; scope: PublicSubmissionScope } | { ok: false; reason: string }>;
