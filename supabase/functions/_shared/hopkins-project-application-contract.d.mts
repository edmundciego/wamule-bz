export interface HopkinsProjectApplicationInput {
  submission_reference: string;
  applicant_full_name: string;
  applicant_address: string;
  nationality: string;
  occupation: string;
  phone: string;
  email: string;
  intended_use: string;
  intended_use_other?: string;
  preferred_map_feature_refs?: string[];
  notes?: string;
  legal_notice_acknowledged: boolean;
  applicant_acknowledgement_signature: string;
}

export function buildHopkinsProjectApplicationPayload(input: HopkinsProjectApplicationInput): Record<string, unknown>;
export function validateHopkinsProjectApplicationPayload(body: unknown, maxMapPreferences?: number): Record<string, unknown> & { error?: never } | { error: string };
