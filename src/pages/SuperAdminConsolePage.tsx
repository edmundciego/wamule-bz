import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import type { AppRole } from "../types/database";

type Phase = { id: string; tenant_id: string; project_id: string; slug: string; name: string; is_default: boolean; is_active: boolean };
type Project = { id: string; tenant_id: string; slug: string; name: string; is_default: boolean; map_experience_mode: "sales" | "demo"; phases: Phase[]; active_phase_count: number; workspace_access_ready: boolean };
type Tenant = { id: string; name: string; slug: string; inbound_alias: string | null; is_active: boolean; projects: Project[]; workspace_access_ready: boolean; project_availability_note: string };
type Profile = { user_id: string; email: string | null; full_name: string | null; role: AppRole; tenant_id: string | null };
type Membership = { id: string; user_id: string; tenant_id: string; project_id: string; phase_id: string | null; member_role: "owner" | "admin" | "staff" | "read_only" };
type AuthUser = { id: string; email: string | null; full_name: string | null };
type ConsoleData = { tenants: Tenant[]; profiles: Profile[]; memberships: Membership[]; auth_users: AuthUser[]; readiness_basis: string };
type ConsoleResponse = { ok?: boolean; error?: string; status?: string; preflight?: Record<string, unknown>; result?: Record<string, unknown>; applied?: boolean; [key: string]: unknown };

const roles: AppRole[] = ["Admin", "Staff", "Read Only", "Super Admin"];

async function consoleRequest(body: Record<string, unknown>): Promise<ConsoleResponse> {
  const { data, error } = await supabase.functions.invoke("super-admin-console", { body });
  if (error) throw new Error(error.message || "Super Admin request failed.");
  const result = data as ConsoleResponse | null;
  if (!result || result.error) throw new Error(result?.error ?? "Super Admin request returned no result.");
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SuperAdminConsolePage() {
  const queryClient = useQueryClient();
  const { data: sessionProfile, isLoading: profileLoading } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const profile = sessionProfile?.profile;
  const [section, setSection] = useState<"workspaces" | "membership">("workspaces");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [phaseName, setPhaseName] = useState("");
  const [phaseSlug, setPhaseSlug] = useState("");
  const [provisionMode, setProvisionMode] = useState<"sales" | "demo">("sales");
  const [pendingManifest, setPendingManifest] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<ConsoleResponse | null>(null);
  const [applyResult, setApplyResult] = useState<ConsoleResponse | null>(null);
  const [memberTenantId, setMemberTenantId] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<AppRole>("Staff");
  const [memberProjectId, setMemberProjectId] = useState("");
  const [memberPhaseId, setMemberPhaseId] = useState("");

  const query = useQuery({
    queryKey: ["super-admin-console"],
    queryFn: () => consoleRequest({ action: "list" }) as Promise<ConsoleData>,
    enabled: profile?.role === "Super Admin",
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const data = query.data as ConsoleData | undefined;
  const memberTenant = data?.tenants.find((tenant) => tenant.id === memberTenantId) ?? null;
  const memberProjects = memberTenant?.projects ?? [];
  const memberPhases = memberProjects.find((project) => project.id === memberProjectId)?.phases.filter((phase) => phase.is_active) ?? [];
  const selectedUser = data?.auth_users.find((user) => user.id === memberUserId) ?? null;
  const selectedProfile = data?.profiles.find((item) => item.user_id === memberUserId) ?? null;
  const currentMemberships = useMemo(
    () => data?.memberships.filter((membership) => membership.user_id === memberUserId) ?? [],
    [data?.memberships, memberUserId],
  );

  async function refresh(success?: string) {
    if (success) setMessage(success);
    await queryClient.invalidateQueries({ queryKey: ["super-admin-console"] });
  }

  async function runAction(body: Record<string, unknown>, success: string) {
    setError(null);
    setMessage(null);
    setWorking(true);
    try {
      await consoleRequest(body);
      setMessage(success);
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setWorking(false);
    }
  }

  function makeManifest(): Record<string, unknown> {
    const companySlug = tenantSlug.trim().toLowerCase();
    const project = projectSlug.trim().toLowerCase();
    const phase = phaseSlug.trim().toLowerCase();
    const projectSettings = provisionMode === "sales"
      ? { public_application: { applications_open: false, show_lot_prices_publicly: false, show_available_lot_count_publicly: false } }
      : {};
    return {
      schema_version: 1,
      operation_id: crypto.randomUUID(),
      company: { slug: companySlug, name: tenantName.trim(), default_project_slug: project },
      projects: [{
        slug: project,
        name: projectName.trim(),
        mode: provisionMode,
        default_phase_slug: phase,
        ...(provisionMode === "sales" ? { inventory: { seed: "empty" } } : { demo_fixture_bundle: null }),
        settings: projectSettings,
        phases: [{ slug: phase, name: phaseName.trim() }],
      }],
      users: [],
    };
  }

  async function previewWorkspace(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setApplyResult(null);
    setWorking(true);
    const manifest = makeManifest();
    try {
      const result = await consoleRequest({ action: "provision", apply: false, manifest });
      setPendingManifest(manifest);
      setPreview(result);
    } catch (previewError) {
      setError(errorText(previewError));
      setPendingManifest(null);
      setPreview(null);
    } finally {
      setWorking(false);
    }
  }

  async function applyWorkspace() {
    if (!pendingManifest || preview?.result?.can_apply !== true) return;
    setError(null);
    setMessage(null);
    setWorking(true);
    try {
      const result = await consoleRequest({ action: "provision", apply: true, manifest: pendingManifest });
      setApplyResult(result);
      if (result.applied !== true) {
        setError(`Workspace was not fully applied: ${JSON.stringify(result.result ?? result)}`);
      } else {
        setMessage("Workspace provisioning returned successfully. Use Retry same operation to confirm the stable result; public map, provider sign-in and domain readiness remain separate.");
        await refresh();
      }
    } catch (applyError) {
      setError(errorText(applyError));
    } finally {
      setWorking(false);
    }
  }

  if (profileLoading) return <LoadingState label="Checking current Super Admin access" />;
  if (profile?.role !== "Super Admin") return <ErrorState message="Only a current Super Admin can open this console." />;

  function hierarchy(tenantId: string, operation: string, fields: Record<string, unknown>, label: string) {
    void runAction({ action: "hierarchy", operation, p_tenant_id: tenantId, ...fields }, label);
  }

  function assign(targetUserId: string, role: AppRole, assignments: Array<Record<string, unknown>>) {
    if (!memberTenantId) return setError("Select the target tenant from the verified workspace list.");
    if (role === "Admin" || role === "Super Admin") assignments = [];
    void runAction({ action: "member", target_user_id: targetUserId, tenant_id: memberTenantId, profile_role: role, memberships: assignments }, "Role and complete project access set saved atomically.");
  }

  function membershipPayload(membership: Membership, allPhasesConfirmed = false) {
    return { project_id: membership.project_id, phase_id: membership.phase_id, member_role: membership.member_role, all_phases_confirmed: allPhasesConfirmed };
  }

  return (
    <div className="grid gap-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Super Admin</p>
        <h1 className="font-display text-3xl font-semibold text-primary">Tenant Console</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Create and manage verified tenant workspaces, project phases and membership. Every operation rechecks the current Super Admin profile on the server.</p>
      </div>
      <div className="flex gap-2">
        <Button variant={section === "workspaces" ? "primary" : "outline"} onClick={() => setSection("workspaces")}>Workspaces</Button>
        <Button variant={section === "membership" ? "primary" : "outline"} onClick={() => setSection("membership")}>Memberships</Button>
        <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh</Button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {message ? <div className="crm-success-panel p-3 text-sm" role="status">{message}</div> : null}
      {query.isLoading ? <LoadingState label="Loading verified tenant workspaces" /> : null}
      {query.error ? <ErrorState message={errorText(query.error)} /> : null}
      {data ? <p className="text-xs text-muted-foreground">{data.readiness_basis}</p> : null}

      {section === "workspaces" ? (
        <>
          <Card>
            <CardHeader><CardTitle>Create a tenant workspace</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <p className="text-sm text-muted-foreground">Preview is read-only. A workspace begins with one project and phase; a Sales workspace starts with empty inventory and applications closed. Map publication and domain connection stay separate.</p>
              <form className="grid gap-4" onSubmit={(event) => void previewWorkspace(event)}>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Company name"><Input value={tenantName} onChange={(event) => setTenantName(event.target.value)} required /></Field>
                  <Field label="Company slug"><Input value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></Field>
                  <Field label="Initial project name"><Input value={projectName} onChange={(event) => setProjectName(event.target.value)} required /></Field>
                  <Field label="Initial project slug"><Input value={projectSlug} onChange={(event) => setProjectSlug(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></Field>
                  <Field label="Default phase name"><Input value={phaseName} onChange={(event) => setPhaseName(event.target.value)} required /></Field>
                  <Field label="Default phase slug"><Input value={phaseSlug} onChange={(event) => setPhaseSlug(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></Field>
                  <Field label="Workspace mode"><Select value={provisionMode} onChange={(event) => setProvisionMode(event.target.value as "sales" | "demo")}><option value="sales">Sales · empty inventory</option><option value="demo">Demo · no fixtures selected</option></Select></Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={working}>{working ? "Checking…" : "Preview workspace"}</Button>
                  <Button type="button" variant="outline" disabled={working || !pendingManifest || preview?.result?.can_apply !== true} onClick={() => void applyWorkspace()}>{applyResult?.applied === true ? "Retry same operation" : "Apply previewed plan"}</Button>
                </div>
              </form>
              {preview ? <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(preview.preflight ?? preview.result, null, 2)}</pre> : null}
              {applyResult ? <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(applyResult.result ?? applyResult, null, 2)}</pre> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Tenants and hierarchy</CardTitle></CardHeader>
            <CardContent className="grid gap-5">
              {(data?.tenants ?? []).map((tenant) => (
                <section key={tenant.id} className="grid gap-3 rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><h2 className="font-semibold">{tenant.name}</h2><p className="text-sm text-muted-foreground">{tenant.slug} · {tenant.id}</p><p className="text-xs text-muted-foreground">{tenant.project_availability_note}</p></div>
                    <div className="flex items-center gap-2"><Badge tone={tenant.is_active ? "green" : "gray"}>{tenant.is_active ? "Active" : "Inactive"}</Badge><Badge tone={tenant.workspace_access_ready ? "green" : "amber"}>{tenant.workspace_access_ready ? "Workspace access ready" : "Needs an active default phase"}</Badge><Button variant="outline" disabled={working} onClick={() => hierarchy(tenant.id, "set_tenant_active", { p_is_active: !tenant.is_active }, tenant.is_active ? "Tenant deactivated." : "Tenant activated.")}>{tenant.is_active ? "Deactivate" : "Reactivate"}</Button></div>
                  </div>
                  <div className="grid gap-4">
                    {tenant.projects.map((project) => <ProjectCard key={project.id} tenant={tenant} project={project} disabled={working} onHierarchy={hierarchy} />)}
                  </div>
                  <AddProjectForm disabled={working} onCreate={(fields) => hierarchy(tenant.id, "create_project", fields, "Project created.")} />
                </section>
              ))}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader><CardTitle>Profile roles and project access</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm text-muted-foreground">Assignments are replaced atomically through M3.4. Profile role remains the capability ceiling. All current and future phases requires explicit confirmation; it remains bounded to one project.</p>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Target tenant"><Select value={memberTenantId} onChange={(event) => { setMemberTenantId(event.target.value); setMemberProjectId(""); setMemberPhaseId(""); }}><option value="">Choose tenant</option>{data?.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} {tenant.is_active ? "" : "(inactive)"}</option>)}</Select></Field>
              <Field label="Existing Auth account"><Select value={memberUserId} onChange={(event) => { const userId = event.target.value; setMemberUserId(userId); const assigned = data?.profiles.find((item) => item.user_id === userId); setMemberRole(assigned?.role ?? "Staff"); }}><option value="">Choose account</option>{data?.auth_users.map((user) => <option key={user.id} value={user.id}>{user.email ?? user.id}{user.full_name ? ` · ${user.full_name}` : ""}</option>)}</Select></Field>
              <Field label="Profile role"><Select value={memberRole} onChange={(event) => setMemberRole(event.target.value as AppRole)}>{roles.map((role) => <option key={role}>{role}</option>)}</Select></Field>
              <Field label="Project"><Select value={memberProjectId} onChange={(event) => { setMemberProjectId(event.target.value); setMemberPhaseId(""); }}><option value="">Choose project</option>{memberProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></Field>
              {memberRole === "Staff" || memberRole === "Read Only" ? <Field label="Active phase"><Select value={memberPhaseId} onChange={(event) => setMemberPhaseId(event.target.value)}><option value="">Choose phase</option>{memberPhases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</Select></Field> : null}
            </div>
            {selectedProfile ? <p className="text-sm">Current profile: <strong>{selectedProfile.role}</strong> · {selectedProfile.tenant_id ? data?.tenants.find((tenant) => tenant.id === selectedProfile.tenant_id)?.name ?? selectedProfile.tenant_id : "No tenant (Super Admin)"}</p> : selectedUser ? <p className="text-sm text-amber-700">This Auth account has no current Wamule profile.</p> : null}
            {currentMemberships.length ? <div className="grid gap-2"><h3 className="font-medium">Current assignments</h3>{currentMemberships.map((membership) => {
              const tenant = data?.tenants.find((item) => item.id === membership.tenant_id);
              const project = tenant?.projects.find((item) => item.id === membership.project_id);
              const phase = project?.phases.find((item) => item.id === membership.phase_id);
              return <div className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm" key={membership.id}><span>{tenant?.name ?? "Tenant"} · {project?.name ?? "Project"} · {phase?.name ?? "All current and future phases"} · {membership.member_role}</span><Button variant="outline" disabled={working || !selectedUser || !memberTenantId} onClick={() => {
                const replacement = currentMemberships.filter((item) => item.id !== membership.id).map((item) => membershipPayload(item, item.phase_id === null));
                assign(memberUserId, selectedProfile?.role ?? memberRole, replacement);
              }}>Remove assignment</Button></div>;
            })}</div> : null}
            <div className="flex flex-wrap gap-2">
              <Button disabled={working || !selectedUser || !memberTenantId} onClick={() => {
                const desiredRole = memberRole;
                const assignmentSet = currentMemberships.map((item) => membershipPayload(item, item.phase_id === null));
                assign(memberUserId, desiredRole, assignmentSet);
              }}>{working ? "Saving…" : "Save role and assignments"}</Button>
              {memberRole === "Staff" || memberRole === "Read Only" ? <Button variant="outline" disabled={working || !selectedUser || !memberTenantId || !memberProjectId || !memberPhaseId} onClick={() => {
                const member_role = memberRole === "Read Only" ? "read_only" : "staff";
                const next = [...currentMemberships.filter((item) => item.tenant_id === memberTenantId).map((item) => membershipPayload(item, item.phase_id === null)), { project_id: memberProjectId, phase_id: memberPhaseId, member_role, all_phases_confirmed: false }];
                assign(memberUserId, memberRole, next);
              }}>Assign selected phase</Button> : null}
              {memberRole === "Staff" || memberRole === "Read Only" ? <Button variant="outline" disabled={working || !selectedUser || !memberTenantId || !memberProjectId} onClick={() => {
                const confirmed = window.confirm("Grant every current and future phase in this project? This replaces phase-specific assignments in this project.");
                if (!confirmed) return;
                const member_role = memberRole === "Read Only" ? "read_only" : "staff";
                const next = [...currentMemberships.filter((item) => item.tenant_id === memberTenantId && item.project_id !== memberProjectId).map((item) => membershipPayload(item, item.phase_id === null)), { project_id: memberProjectId, phase_id: null, member_role, all_phases_confirmed: true }];
                assign(memberUserId, memberRole, next);
              }}>Grant all project phases…</Button> : null}
            </div>
            <p className="text-xs text-muted-foreground">A target assigned to another tenant or containing conflicting cross-tenant memberships is rejected by the database operation. This screen never creates an Auth account or sends invitations; use the M4.3 onboarding flow first.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ProjectCard({ tenant, project, disabled, onHierarchy }: { tenant: Tenant; project: Project; disabled: boolean; onHierarchy: (tenantId: string, operation: string, fields: Record<string, unknown>, label: string) => void }) {
  const [name, setName] = useState(project.name);
  const [phaseName, setPhaseName] = useState("");
  const [phaseSlug, setPhaseSlug] = useState("");
  return (
    <div className="grid gap-3 rounded-md bg-muted/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="font-medium">{project.name} <span className="text-xs text-muted-foreground">({project.slug})</span></p><p className="text-xs text-muted-foreground">{project.id} · {project.map_experience_mode} · {project.active_phase_count} active phases</p></div>
        <div className="flex gap-2">{project.is_default ? <Badge tone="green">Default project</Badge> : <Button variant="outline" disabled={disabled || !project.workspace_access_ready} onClick={() => onHierarchy(tenant.id, "set_default_project", { p_project_id: project.id }, "Default project changed.")}>Make default</Button>}{project.workspace_access_ready ? <Badge tone="green">Usable default phase</Badge> : <Badge tone="amber">No active default phase</Badge>}</div>
      </div>
      <div className="flex flex-wrap gap-2"><Field label="Project name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><div className="flex items-end"><Button variant="outline" disabled={disabled || name.trim() === project.name} onClick={() => onHierarchy(tenant.id, "update_project", { p_project_id: project.id, p_name: name.trim(), p_map_experience_mode: project.map_experience_mode }, "Project name updated.")}>Save name</Button></div></div>
      <div className="grid gap-2">
        {project.phases.map((phase) => <PhaseRow key={phase.id} tenant={tenant} project={project} phase={phase} disabled={disabled} onHierarchy={onHierarchy} />)}
      </div>
      <form className="grid gap-2 rounded border bg-card p-3 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={(event) => { event.preventDefault(); onHierarchy(tenant.id, "create_phase", { p_project_id: project.id, p_name: phaseName.trim(), p_slug: phaseSlug.trim().toLowerCase() }, "Phase created."); setPhaseName(""); setPhaseSlug(""); }}>
        <Field label="New phase name"><Input value={phaseName} onChange={(event) => setPhaseName(event.target.value)} required /></Field>
        <Field label="New immutable phase slug"><Input value={phaseSlug} onChange={(event) => setPhaseSlug(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></Field>
        <Button disabled={disabled || !tenant.is_active}>Add phase</Button>
      </form>
    </div>
  );
}

function PhaseRow({ tenant, project, phase, disabled, onHierarchy }: { tenant: Tenant; project: Project; phase: Phase; disabled: boolean; onHierarchy: (tenantId: string, operation: string, fields: Record<string, unknown>, label: string) => void }) {
  const [name, setName] = useState(phase.name);
  const scope = { p_project_id: project.id, p_phase_id: phase.id };
  return <div className="grid gap-2 rounded border bg-card p-2 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
    <div><p className="text-xs text-muted-foreground">{phase.slug} · {phase.is_active ? "active" : "inactive"}</p><Field label="Phase name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field></div>
    {phase.is_default ? <Badge tone="green">Default phase</Badge> : <Button variant="outline" disabled={disabled || !phase.is_active} onClick={() => {
      const currentDefault = project.phases.find((candidate) => candidate.is_default);
      const confirmed = window.confirm(
        `Make ${phase.name} (${phase.slug}) the default phase for ${project.name} (${project.slug})?\n\n` +
        `This changes the fallback phase for public routes and requests that omit an explicit phase. ` +
        `The previous default${currentDefault ? `, ${currentDefault.name} (${currentDefault.slug}),` : ""} will be replaced. ` +
        `Existing phase-owned inventory, memberships, applications, contracts, and history will not move. ` +
        `The change will be recorded with before and after phase values.`
      );
      if (confirmed) onHierarchy(tenant.id, "set_default_phase", scope, "Default phase changed.");
    }}>Make default</Button>}
    <Button variant="outline" disabled={disabled || name.trim() === phase.name} onClick={() => onHierarchy(tenant.id, "update_phase", { ...scope, p_name: name.trim() }, "Phase name updated.")}>Save name</Button>
    <Button variant="outline" disabled={disabled || (!phase.is_active && !tenant.is_active)} onClick={() => onHierarchy(tenant.id, "set_phase_active", { ...scope, p_is_active: !phase.is_active }, phase.is_active ? "Phase deactivated." : "Phase activated.")}>{phase.is_active ? "Deactivate" : "Activate"}</Button>
  </div>;
}

function AddProjectForm({ disabled, onCreate }: { disabled: boolean; onCreate: (fields: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<"sales" | "demo">("sales");
  const [phaseName, setPhaseName] = useState("");
  const [phaseSlug, setPhaseSlug] = useState("");
  return <form className="grid gap-3 rounded border p-3 md:grid-cols-[1fr_1fr_1fr_1fr_160px_auto] md:items-end" onSubmit={(event) => { event.preventDefault(); onCreate({ p_name: name.trim(), p_slug: slug.trim().toLowerCase(), p_map_experience_mode: mode, p_phase_name: phaseName.trim(), p_phase_slug: phaseSlug.trim().toLowerCase() }); setName(""); setSlug(""); setPhaseName(""); setPhaseSlug(""); }}>
    <Field label="New project name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
    <Field label="New immutable project slug"><Input value={slug} onChange={(event) => setSlug(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></Field>
    <Field label="Initial default phase name"><Input value={phaseName} onChange={(event) => setPhaseName(event.target.value)} required /></Field>
    <Field label="Initial default phase slug"><Input value={phaseSlug} onChange={(event) => setPhaseSlug(event.target.value)} required pattern="[a-z0-9][a-z0-9-]{0,62}" /></Field>
    <Field label="Mode"><Select value={mode} onChange={(event) => setMode(event.target.value as "sales" | "demo")}><option value="sales">Sales</option><option value="demo">Demo</option></Select></Field>
    <Button disabled={disabled}>Add project and default phase</Button>
  </form>;
}
