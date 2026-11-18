import { createContext, useContext } from "react";
export type WorkspaceChoice = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  phaseId: string;
  phaseName: string;
  phaseSlug: string;
  mapExperienceMode: "sales" | "demo";
  isDefaultProject: boolean;
  isDefaultPhase: boolean;
};

export type WorkspaceScopeValue = {
  choices: WorkspaceChoice[];
  workspace: WorkspaceChoice | null;
  isLoading: boolean;
  error: string | null;
  canSelectTenant: boolean;
  setTenant: (tenantId: string) => void;
  setProject: (projectId: string) => void;
  setPhase: (phaseId: string) => void;
};

export const WorkspaceScopeContext = createContext<WorkspaceScopeValue | null>(null);

export function useWorkspaceScope() {
  const value = useContext(WorkspaceScopeContext);
  if (!value) throw new Error("WorkspaceScopeProvider is missing from the authenticated layout.");
  return value;
}
