import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Field, Select } from "../ui/Field";
import { supabase } from "../../lib/supabase";
import { accessibleWorkspaceChoices, preferredWorkspace, workspaceScopeKey } from "../../lib/workspaceScope";
import type { AdminProfile } from "../../types/database";
import { WorkspaceScopeContext, useWorkspaceScope, type WorkspaceChoice, type WorkspaceScopeValue } from "./workspaceScopeContext";

function storageKey(userId: string) {
  return `wamule.active-workspace:${userId}`;
}

function readSavedWorkspace(userId: string): Partial<Pick<WorkspaceChoice, "tenantId" | "projectId" | "phaseId">> | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      tenantId: typeof parsed.tenantId === "string" ? parsed.tenantId : undefined,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
      phaseId: typeof parsed.phaseId === "string" ? parsed.phaseId : undefined,
    };
  } catch {
    return null;
  }
}

async function loadWorkspaceChoices(profile: AdminProfile): Promise<WorkspaceChoice[]> {
  const isSuperAdmin = profile.role === "Super Admin";
  if (!isSuperAdmin && !profile.tenant_id) return [];

  let organizationsQuery = supabase.from("organizations").select("id, name, slug, is_active").eq("is_active", true).order("name");
  if (!isSuperAdmin) organizationsQuery = organizationsQuery.eq("id", profile.tenant_id!);
  const { data: organizations, error: organizationsError } = await organizationsQuery;
  if (organizationsError) throw organizationsError;

  let projectsQuery = supabase.from("projects").select("id, tenant_id, name, slug, is_default, map_experience_mode").order("name");
  if (!isSuperAdmin) projectsQuery = projectsQuery.eq("tenant_id", profile.tenant_id!);
  const { data: projects, error: projectsError } = await projectsQuery;
  if (projectsError) throw projectsError;

  const projectIds = (projects ?? []).map((project) => project.id as string);
  if (!projectIds.length) return [];
  const { data: phases, error: phasesError } = await supabase
    .from("development_phases")
    .select("id, tenant_id, project_id, name, slug, is_default, is_active")
    .in("project_id", projectIds)
    .eq("is_active", true)
    .order("name");
  if (phasesError) throw phasesError;

  const orgById = new Map((organizations ?? []).map((org) => [org.id as string, org]));
  const phasesByProject = new Map<string, NonNullable<typeof phases>>();
  for (const phase of phases ?? []) {
    const current = phasesByProject.get(phase.project_id as string) ?? [];
    current.push(phase);
    phasesByProject.set(phase.project_id as string, current);
  }

  return (projects ?? []).flatMap((project) => {
    const tenant = orgById.get(project.tenant_id as string);
    if (!tenant) return [];
    return (phasesByProject.get(project.id as string) ?? []).map((phase) => ({
      tenantId: tenant.id as string,
      tenantName: tenant.name as string,
      tenantSlug: tenant.slug as string,
      projectId: project.id as string,
      projectName: project.name as string,
      projectSlug: project.slug as string,
      phaseId: phase.id as string,
      phaseName: phase.name as string,
      phaseSlug: phase.slug as string,
      mapExperienceMode: (project.map_experience_mode as "sales" | "demo" | undefined) ?? "sales",
      isDefaultProject: project.is_default as boolean,
      isDefaultPhase: phase.is_default as boolean,
    }));
  });
}

export function WorkspaceScopeProvider({ profile, profileLoading = false, children }: { profile: AdminProfile | null; profileLoading?: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [workspace, setWorkspaceState] = useState<WorkspaceChoice | null>(null);
  const hydratedUserRef = useRef<string | null>(null);
  const lastScopeRef = useRef("");
  const canSelectTenant = profile?.role === "Super Admin";
  const optionsQuery = useQuery({
    queryKey: ["workspace-options", profile?.user_id ?? null, profile?.role ?? null, profile?.tenant_id ?? null],
    queryFn: () => loadWorkspaceChoices(profile!),
    enabled: Boolean(profile),
    staleTime: 60_000,
    retry: false,
  });
  const choices = useMemo(() => accessibleWorkspaceChoices(optionsQuery.data ?? [], profile), [optionsQuery.data, profile]);

  useEffect(() => {
    if (!profile || !optionsQuery.data || hydratedUserRef.current === profile.user_id) return;
    const next = preferredWorkspace(choices, readSavedWorkspace(profile.user_id));
    setWorkspaceState(next);
    hydratedUserRef.current = profile.user_id;
  }, [choices, optionsQuery.data, profile]);

  const selectWorkspace = useCallback((next: WorkspaceChoice | null) => {
    if (!next || workspaceScopeKey(next) === workspaceScopeKey(workspace)) return;
    const tenantQueries = {
      predicate: (query: { queryKey: readonly unknown[] }) => !["session-profile", "workspace-options", "settings-session", "settings-current-profile"].includes(String(query.queryKey[0] ?? "")),
    };
    void queryClient.cancelQueries(tenantQueries);
    queryClient.removeQueries(tenantQueries);
    setWorkspaceState(next);
  }, [queryClient, workspace]);

  useEffect(() => {
    if (!profile || !workspace) return;
    window.localStorage.setItem(storageKey(profile.user_id), JSON.stringify({
      tenantId: workspace.tenantId,
      projectId: workspace.projectId,
      phaseId: workspace.phaseId,
    }));
    const scope = workspaceScopeKey(workspace);
    lastScopeRef.current = scope;
  }, [profile, workspace]);

  useEffect(() => {
    hydratedUserRef.current = null;
    lastScopeRef.current = "";
    setWorkspaceState(null);
  }, [profile?.user_id]);

  const activeWorkspace = choices.find((choice) => workspaceScopeKey(choice) === workspaceScopeKey(workspace)) ?? null;
  const setTenant = useCallback((tenantId: string) => {
    if (!canSelectTenant) return;
    const next = choices.find((choice) => choice.tenantId === tenantId && choice.isDefaultProject && choice.isDefaultPhase)
      ?? choices.find((choice) => choice.tenantId === tenantId);
    selectWorkspace(next ?? null);
  }, [canSelectTenant, choices, selectWorkspace]);
  const setProject = useCallback((projectId: string) => {
    const next = choices.find((choice) => choice.projectId === projectId && choice.isDefaultPhase)
      ?? choices.find((choice) => choice.projectId === projectId);
    selectWorkspace(next ?? null);
  }, [choices, selectWorkspace]);
  const setPhase = useCallback((phaseId: string) => {
    const next = choices.find((choice) => choice.phaseId === phaseId);
    selectWorkspace(next ?? null);
  }, [choices, selectWorkspace]);

  const value = useMemo<WorkspaceScopeValue>(() => ({
    choices,
    workspace: activeWorkspace,
    isLoading: profileLoading || optionsQuery.isLoading || Boolean(profile && !activeWorkspace && choices.length > 0),
    error: optionsQuery.error ? "Your account could not load workspaces it is permitted to access." : null,
    canSelectTenant,
    setTenant,
    setProject,
    setPhase,
  }), [activeWorkspace, canSelectTenant, choices, optionsQuery.error, optionsQuery.isLoading, profile, profileLoading, setPhase, setProject, setTenant]);

  return <WorkspaceScopeContext.Provider value={value}>{children}</WorkspaceScopeContext.Provider>;
}

export function WorkspaceSelector() {
  const { choices, workspace, isLoading, error, canSelectTenant, setTenant, setProject, setPhase } = useWorkspaceScope();
  const tenantChoices = [...new Map(choices.map((choice) => [choice.tenantId, choice])).values()];
  const projectChoices = choices.filter((choice, index, values) => values.findIndex((other) => other.projectId === choice.projectId) === index);
  const phaseChoices = choices.filter((choice) => choice.projectId === workspace?.projectId);
  const mapUrl = workspace
    ? `/embed/${encodeURIComponent(workspace.tenantSlug)}/${encodeURIComponent(workspace.projectSlug)}?phase=${encodeURIComponent(workspace.phaseSlug)}`
    : null;

  if (isLoading) return <div className="text-sm text-muted-foreground" role="status">Loading workspaces…</div>;
  if (error || !workspace) {
    return <p className="max-w-sm text-sm text-danger" role="alert">{error ?? "No project workspace is assigned to this account."}</p>;
  }

  return (
    <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_minmax(140px,0.8fr)_auto] sm:items-end">
      <Field label="Tenant">
        <Select aria-label="Workspace tenant" value={workspace.tenantId} disabled={!canSelectTenant} onChange={(event) => setTenant(event.target.value)}>
          {tenantChoices.map((choice) => <option key={choice.tenantId} value={choice.tenantId}>{choice.tenantName}</option>)}
        </Select>
      </Field>
      <Field label="Project">
        <Select aria-label="Workspace project" value={workspace.projectId} onChange={(event) => setProject(event.target.value)}>
          {projectChoices.filter((choice) => choice.tenantId === workspace.tenantId).map((choice) => <option key={choice.projectId} value={choice.projectId}>{choice.projectName}</option>)}
        </Select>
      </Field>
      <Field label="Phase">
        <Select aria-label="Workspace phase" value={workspace.phaseId} onChange={(event) => setPhase(event.target.value)}>
          {phaseChoices.map((choice) => <option key={choice.phaseId} value={choice.phaseId}>{choice.phaseName}</option>)}
        </Select>
      </Field>
      <div className="flex items-center gap-3 pb-1">
        {mapUrl ? <a className="inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-3 text-sm font-semibold text-primary hover:bg-primary-soft focus-ring" href={mapUrl} target="_blank" rel="noreferrer">
          Open map <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a> : null}
      </div>
    </div>
  );
}
