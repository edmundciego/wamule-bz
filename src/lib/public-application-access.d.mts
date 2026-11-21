export function resolvePublicApplicationAccess(data: {
  publicApplication: {
    applications_open: boolean;
    notices_complete: boolean;
    allowed_intended_uses?: string[];
  };
  siteExperience: {
    applicationType: string;
    enabledModules: { application: boolean };
  };
}): { accepting: boolean; canSubmit: boolean };
