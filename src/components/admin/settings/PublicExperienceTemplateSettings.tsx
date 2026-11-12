import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, LayoutTemplate } from "lucide-react";
import { Button } from "../../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/Card";
import { ErrorState, LoadingState } from "../../ui/State";
import { supabase } from "../../../lib/supabase";
import {
  defaultPublicExperience,
  normalizePublicExperience,
  PUBLIC_SITE_MODULES,
  PUBLIC_SITE_TEMPLATES,
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
  const selectedTemplate = PUBLIC_SITE_TEMPLATES.find((item) => item.id === current?.templateId) ?? PUBLIC_SITE_TEMPLATES[0];

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
    setSavedMessage("Public site template and modules saved for this project.");
    queryClient.setQueryData(["admin-public-site-experience", tenantId, projectId], normalized);
    await queryClient.invalidateQueries({ queryKey: ["public-site-experience", workspace?.tenantSlug, workspace?.projectSlug, workspace?.phaseSlug] });
  }

  function selectTemplate(templateId: PublicExperienceConfig["templateId"]) {
    setSavedMessage(null);
    setDraft((value) => value ? { ...value, templateId } : value);
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
          Choose the public presentation for <strong>{workspace.projectName}</strong>. Template and module choices do not change application fields or notices, user permissions, tenant ownership, or map access.
        </p>
        {configQuery.isLoading ? <LoadingState label="Loading project site settings" /> : null}
        {configQuery.isError ? <ErrorState message={configQuery.error instanceof Error ? configQuery.error.message : "Project site settings could not be loaded."} /> : null}
        {errorMessage ? <ErrorState message={errorMessage} /> : null}

        {current ? (
          <>
            <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!canManage || configQuery.isLoading || saving}>
              <legend className="sr-only">Select a public site template</legend>
              {PUBLIC_SITE_TEMPLATES.map((template) => {
                const selected = current.templateId === template.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectTemplate(template.id)}
                    className={`grid min-h-36 content-start gap-3 rounded-xl border p-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${selected ? "border-primary bg-primary-soft/45 ring-1 ring-primary/30" : "border-border bg-card hover:border-primary/40"}`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-foreground">{template.name}</span>
                      {selected ? <Check aria-hidden="true" className="h-4 w-4 text-primary" /> : null}
                    </span>
                    <span className="text-sm leading-5 text-muted-foreground">{template.description}</span>
                    <span aria-hidden="true" className={`grid h-12 grid-cols-[1fr_0.7fr] gap-1 rounded-md border p-1.5 ${template.id === "hopkins-project" ? "border-[#173f2d]/15 bg-[#fffdf8]" : "border-primary/15 bg-background"}`}>
                      <span className={`rounded-sm ${template.id === "hopkins-project" ? "bg-[#173f2d]/15" : "bg-primary/10"}`} />
                      <span className="grid gap-1"><span className="rounded-sm bg-secondary/30" /><span className="rounded-sm bg-muted" /></span>
                    </span>
                  </button>
                );
              })}
            </fieldset>

            <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold"><Eye aria-hidden="true" className="h-4 w-4" />Preview: {selectedTemplate.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{workspace.projectName} · {workspace.phaseName}</p>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">The preview uses this project’s existing company profile and configured application workflow.</p>
              </div>
              <div aria-label={`${selectedTemplate.name} preview`} className={`grid content-center gap-2 rounded-lg border p-3 ${current.templateId === "hopkins-project" ? "border-[#173f2d]/15 bg-[#fffdf8]" : "border-primary/15 bg-background"}`}>
                {current.templateId === "hopkins-project" ? (
                  <>
                    <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#8a5a35]">Ceiba Realty &amp; Development</span>
                    <span className="font-semibold text-[#173f2d]">{workspace.projectName}</span>
                    <span className="text-xs leading-4 text-[#52635a]">A project homepage with map and inquiry sections.</span>
                    <span className="grid h-6 grid-cols-4 gap-1" aria-hidden="true">{[0, 1, 2, 3].map((item) => <span key={item} className="rounded-sm bg-[#173f2d]/15" />)}</span>
                  </>
                ) : (
                  <>
                    <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-secondary">Wamule Classic</span>
                    <span className="font-semibold text-primary">{workspace.projectName} application</span>
                    <span className="grid grid-cols-3 gap-1" aria-hidden="true"><span className="h-5 rounded-sm bg-primary/10" /><span className="h-5 rounded-sm bg-secondary/15" /><span className="h-5 rounded-sm bg-muted" /></span>
                    <span className="text-xs leading-4 text-muted-foreground">Project summary, lot preferences, and application steps.</span>
                  </>
                )}
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
