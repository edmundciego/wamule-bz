import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, LayoutTemplate } from "lucide-react";
import { Button } from "../../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/Card";
import { ErrorState, LoadingState } from "../../ui/State";
import { supabase } from "../../../lib/supabase";
import {
  defaultPublicExperience,
  normalizePublicExperience,
  PUBLIC_SITE_MODULES,
  type PublicExperienceConfig,
} from "../../../lib/publicExperience.mjs";
import type { WorkspaceChoice } from "../../auth/workspaceScopeContext";

export function PublicExperienceTemplateSettings({
  workspace,
  canManage,
}: {
  workspace: WorkspaceChoice | null;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const tenantId = workspace?.tenantId ?? null;
  const projectId = workspace?.projectId ?? null;
  const scope = useMemo(() => workspace ? ({
    tenantSlug: workspace.tenantSlug,
    projectSlug: workspace.projectSlug,
    phaseSlug: workspace.phaseSlug,
  }) : null, [workspace]);
  const defaultConfig = useMemo(() => scope ? defaultPublicExperience(scope) : null, [scope]);
  const configQuery = useQuery({
    queryKey: ["admin-public-site-experience", tenantId, projectId],
    queryFn: async () => {
      if (!tenantId || !projectId) throw new Error("Choose a project before editing its site experience.");
      const { data, error } = await supabase.rpc("get_project_site_experience", {
        p_tenant_id: tenantId,
        p_project_id: projectId,
      });
      if (error) throw error;
      return normalizePublicExperience(scope!, data);
    },
    enabled: Boolean(canManage && tenantId && projectId && scope),
    staleTime: 30_000,
  });
  const [draft, setDraft] = useState<PublicExperienceConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (configQuery.data) setDraft(configQuery.data);
    else if (defaultConfig) setDraft(defaultConfig);
  }, [configQuery.data, defaultConfig]);

  const current = draft ?? defaultConfig;
  const configChanged = Boolean(current && configQuery.data
    && JSON.stringify(current) !== JSON.stringify(configQuery.data));
  async function save() {
    if (!canManage || !tenantId || !projectId || !current) return;
    setErrorMessage(null);
    setSavedMessage(null);
    setSaving(true);
    const { data, error } = await supabase.rpc("save_project_site_experience", {
      p_tenant_id: tenantId,
      p_project_id: projectId,
      p_template_id: current.templateId,
      p_enabled_modules: current.enabledModules,
    });
    setSaving(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    const normalized = normalizePublicExperience(scope!, data);
    setDraft(normalized);
    setSavedMessage("Public site modules saved for this project.");
    queryClient.setQueryData(["admin-public-site-experience", tenantId, projectId], normalized);
    await queryClient.invalidateQueries({ queryKey: ["public-site-experience", workspace?.tenantSlug, workspace?.projectSlug, workspace?.phaseSlug] });
  }

  function toggleModule(id: keyof PublicExperienceConfig["enabledModules"]) {
    setSavedMessage(null);
    setDraft((value) => value ? {
      ...value,
      enabledModules: { ...value.enabledModules, [id]: !value.enabledModules[id] },
    } : value);
  }

  if (!workspace || !canManage) return null;

  return (
    <Card className="v2-workflow-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LayoutTemplate className="h-5 w-5" />Public site template</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          <strong>{workspace.projectName}</strong> uses the shared Wamule Classic layout. Branding, project content, application requirements, permissions, and tenant ownership remain configured separately.
        </p>
        {configQuery.isLoading ? <LoadingState label="Loading project site settings" /> : null}
        {configQuery.isError ? <ErrorState message={configQuery.error instanceof Error ? configQuery.error.message : "Project site settings could not be loaded."} /> : null}
        {errorMessage ? <ErrorState message={errorMessage} /> : null}

        {current ? (
          <>
            <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold"><Eye aria-hidden="true" className="h-4 w-4" />Shared template: Wamule Classic</p>
                <p className="mt-1 text-sm text-muted-foreground">{workspace.projectName} · {workspace.phaseName}</p>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">Each project fills the same page and application structure with its own company profile, notices, project content, and workflow settings.</p>
              </div>
              <div aria-label="Wamule Classic shared template preview" className="grid content-center gap-2 rounded-lg border border-primary/15 bg-background p-3">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-secondary">Shared public page</span>
                <span className="font-semibold text-primary">{workspace.projectName}</span>
                <span className="grid grid-cols-3 gap-1" aria-hidden="true"><span className="h-5 rounded-sm bg-primary/10" /><span className="h-5 rounded-sm bg-secondary/15" /><span className="h-5 rounded-sm bg-muted" /></span>
                <span className="text-xs leading-4 text-muted-foreground">Shared hero, panels, map, and application wizard.</span>
              </div>
            </div>

            <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!canManage || configQuery.isLoading || saving}>
              <legend className="text-sm font-semibold">Enabled public modules</legend>
              {PUBLIC_SITE_MODULES.map((module) => (
                <label key={module.id} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={current.enabledModules[module.id]}
                    onChange={() => toggleModule(module.id)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span className="grid gap-0.5"><span className="font-medium">{module.name}</span><span className="text-xs leading-4 text-muted-foreground">{module.description}</span></span>
                </label>
              ))}
            </fieldset>

            {savedMessage ? <p role="status" className="text-sm font-medium text-success">{savedMessage}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!canManage || !configChanged || configQuery.isLoading || saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save public experience"}
              </Button>
              {!canManage ? <span className="text-sm text-muted-foreground">An Admin or Super Admin can change this setting.</span> : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
