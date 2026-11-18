import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate } from "lucide-react";
import {
  normalizePublicExperience,
  PUBLIC_SITE_MODULES,
  PUBLIC_SITE_TEMPLATE_ID,
  type PublicExperienceConfig,
} from "../../../lib/publicExperience.mjs";
import { supabase } from "../../../lib/supabase";
import type { WorkspaceChoice } from "../../auth/workspaceScopeContext";
import { Button } from "../../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/Card";
import { ErrorState, LoadingState } from "../../ui/State";

export function PublicExperienceTemplateSettings({
  workspace,
  canManage,
}: {
  workspace: WorkspaceChoice | null;
  canManage: boolean;
}) {
  if (!workspace || !canManage) return null;
  return <ProjectHomepageSettings key={`${workspace.tenantId}/${workspace.projectId}`} workspace={workspace} />;
}

function ProjectHomepageSettings({ workspace }: { workspace: WorkspaceChoice }) {
  const { tenantId, projectId, tenantSlug, projectSlug } = workspace;
  const queryClient = useQueryClient();
  const queryKey = ["admin-public-site-experience", tenantId, projectId] as const;
  const configQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_project_site_experience", {
        p_tenant_id: tenantId,
        p_project_id: projectId,
      });
      if (error) throw error;
      return normalizePublicExperience(data);
    },
    staleTime: 30_000,
  });
  const [draft, setDraft] = useState<PublicExperienceConfig["enabledModules"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedModules = configQuery.data?.enabledModules;
  const enabledModules = draft ?? savedModules;
  const changed = draft && PUBLIC_SITE_MODULES.some(({ id }) => draft[id] !== savedModules?.[id]);

  async function save() {
    if (!enabledModules || !changed || saving) return;
    setErrorMessage(null);
    setSaved(false);
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("save_project_site_experience", {
        p_tenant_id: tenantId,
        p_project_id: projectId,
        p_template_id: PUBLIC_SITE_TEMPLATE_ID,
        p_enabled_modules: enabledModules,
      });
      if (error) throw error;
      queryClient.setQueryData(queryKey, normalizePublicExperience(data));
      setDraft(null);
      setSaved(true);
      await queryClient.invalidateQueries({
        predicate: ({ queryKey: key }) => key[0] === "public-site-experience" && key[2] === tenantSlug && key[3] === projectSlug,
      });
    } catch (error) {
      setErrorMessage(error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "The homepage settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="v2-workflow-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LayoutTemplate aria-hidden="true" className="h-5 w-5" />Public homepage</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          <strong>{workspace.projectName}</strong> uses the Regular template. Choose which widgets appear on its homepage. Each phase supplies its own map and application status.
        </p>
        {configQuery.isLoading ? <LoadingState label="Loading homepage settings" /> : null}
        {configQuery.isError ? <ErrorState message={configQuery.error instanceof Error ? configQuery.error.message : "Homepage settings could not be loaded."} /> : null}
        {errorMessage ? <ErrorState message={errorMessage} /> : null}

        {enabledModules ? (
          <>
            <fieldset className="grid gap-3 sm:grid-cols-2" disabled={configQuery.isError || saving}>
              <legend className="mb-2 text-sm font-semibold">Homepage widgets</legend>
              {PUBLIC_SITE_MODULES.map((module) => (
                <label key={module.id} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={enabledModules[module.id]}
                    onChange={(event) => {
                      setSaved(false);
                      setDraft({ ...enabledModules, [module.id]: event.target.checked });
                    }}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{module.name}</span>
                    <span className="text-xs leading-4 text-muted-foreground">{module.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {saved ? <p role="status" className="text-sm font-medium text-success">Homepage widgets saved.</p> : null}
            <div>
              <Button type="button" disabled={!changed || configQuery.isError || saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save homepage widgets"}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
