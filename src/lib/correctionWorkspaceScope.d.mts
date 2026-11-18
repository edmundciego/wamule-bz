export interface CorrectionWorkspaceMasterplanScope {
  tenantId: string;
  projectId: string;
  phaseId: string;
  isDefaultProject: boolean;
  isDefaultPhase: boolean;
}

export function correctionWorkspaceScopeKey(tenant: string, project: string, phase: string): string;
export function correctionWorkspaceDraftStorageKey(tenant: string, project: string, phase: string): string;
export function correctionWorkspaceBenchmarkReviewStorageKey(benchmarkId: string, manifestSha: string, phase: string): string;
export function correctionWorkspacePhaseStorageKey(baseKey: string, phase: string): string;
export function loadCorrectionWorkspaceMasterplan(
  client: object,
  scope: CorrectionWorkspaceMasterplanScope,
): Promise<string | null>;
