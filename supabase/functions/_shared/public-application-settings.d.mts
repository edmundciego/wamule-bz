export interface EffectivePublicApplicationSettings {
  applicationsOpen: boolean;
  publicNoticeText: string;
  acknowledgmentText: string;
  noticesComplete: boolean;
}

export function resolvePublicApplicationSettings(
  companyInput: unknown,
  projectInput: unknown,
  phaseIdInput?: unknown,
): EffectivePublicApplicationSettings;
