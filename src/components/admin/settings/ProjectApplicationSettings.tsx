import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { Field, Input, Select, Textarea } from "../../ui/Field";
import { ErrorState, LoadingState } from "../../ui/State";
import { resolvePublicApplicationSettings } from "../../../../supabase/functions/_shared/public-application-settings.mjs";
import type { WorkspaceChoice } from "../../auth/workspaceScopeContext";
import { supabase } from "../../../lib/supabase";

type RecordValue = Record<string, unknown>;
type Phase = { id: string; name: string; slug: string };
type ProjectApplicationDraft = {
  application_type: "land_purchase" | "project_application";
  applications_open: boolean;
  allowed_phase_ids: string[];
  notice_version: string;
  public_notice_text: string;
  application_acknowledgment_text: string;
  allowed_intended_uses: string[];
  max_map_preferences: number;
  default_confirmation_message: string;
};
type SettingsResponse = {
  projectApplication: RecordValue;
  companyApplication: RecordValue;
  phases: Phase[];
};

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hydrateDraft(projectInput: unknown, companyInput: unknown, phases: Phase[]): ProjectApplicationDraft {
  const project = asRecord(projectInput);
  const company = asRecord(companyInput);
  const inherited = (key: string) => Object.prototype.hasOwnProperty.call(project, key) ? project[key] : company[key];
  const allowed = inherited("allowed_intended_uses");
  return {
    application_type: project.application_type === "project_application" ? "project_application" : "land_purchase",
    applications_open: project.applications_open === true,
    allowed_phase_ids: Array.isArray(project.allowed_phase_ids)
      ? project.allowed_phase_ids.filter((value): value is string => typeof value === "string")
      : phases.map((phase) => phase.id),
    notice_version: text(inherited("notice_version")),
    public_notice_text: text(inherited("public_notice_text")),
    application_acknowledgment_text: text(inherited("application_acknowledgment_text")),
    allowed_intended_uses: Array.isArray(allowed) ? allowed.filter((value): value is string => typeof value === "string") : [],
    max_map_preferences: typeof inherited("max_map_preferences") === "number" ? Number(inherited("max_map_preferences")) : 5,
    default_confirmation_message: text(inherited("default_confirmation_message")),
  };
}

export function ProjectApplicationSettings({ workspace, canManage }: { workspace: WorkspaceChoice | null; canManage: boolean }) {
  const queryClient = useQueryClient();
  const tenantId = workspace?.tenantId ?? null;
  const projectId = workspace?.projectId ?? null;
  const queryKey = ["project-application-settings", tenantId, projectId];
  const settingsQuery = useQuery({
    queryKey,
    enabled: Boolean(canManage && tenantId && projectId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_project_application_settings", {
        p_tenant_id: tenantId!, p_project_id: projectId!,
      });
      if (error) throw error;
      const value = asRecord(data);
      return {
        projectApplication: asRecord(value.projectApplication),
        companyApplication: asRecord(value.companyApplication),
        phases: Array.isArray(value.phases) ? value.phases.filter(isPhase) : [],
      } satisfies SettingsResponse;
    },
  });
  const [draft, setDraft] = useState<ProjectApplicationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data) setDraft(hydrateDraft(settingsQuery.data.projectApplication, settingsQuery.data.companyApplication, settingsQuery.data.phases));
    else setDraft(null);
  }, [settingsQuery.data]);

  const effectiveByPhase = useMemo(() => {
    if (!settingsQuery.data || !draft) return [];
    const project = { ...settingsQuery.data.projectApplication, ...draft };
    return settingsQuery.data.phases.map((phase) => {
      const effective = resolvePublicApplicationSettings(settingsQuery.data!.companyApplication, project, phase.id);
      const open = effective.applicationsOpen && effective.noticesComplete;
      const reasons = [
        settingsQuery.data!.companyApplication.applications_open !== true ? "Tenant intake is closed" : null,
        draft.applications_open !== true ? "Project intake is closed" : null,
        !draft.allowed_phase_ids.includes(phase.id) ? "Phase is not allowed" : null,
        !effective.noticesComplete ? "Required notice or form settings are incomplete" : null,
      ].filter((reason): reason is string => Boolean(reason));
      return { ...phase, open, reasons };
    });
  }, [settingsQuery.data, draft]);

  if (!workspace || !canManage) return null;
  if (settingsQuery.isLoading) return <LoadingState label="Loading project application settings" />;
  if (settingsQuery.isError) return <ErrorState message={settingsQuery.error instanceof Error ? settingsQuery.error.message : "Project application settings could not be loaded."} />;
  if (!settingsQuery.data || !draft) return null;

  function update<K extends keyof ProjectApplicationDraft>(key: K, value: ProjectApplicationDraft[K]) {
    setMessage(null);
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function togglePhase(phaseId: string) {
    const allowed = draft!.allowed_phase_ids.includes(phaseId)
      ? draft!.allowed_phase_ids.filter((id) => id !== phaseId)
      : [...draft!.allowed_phase_ids, phaseId];
    update("allowed_phase_ids", allowed);
  }

  async function save() {
    if (!tenantId || !projectId || !draft) return;
    const intendedUses = [...new Set(draft.allowed_intended_uses.map((value) => value.trim()).filter(Boolean))];
    if (!draft.notice_version.trim() || !draft.public_notice_text.trim() || !draft.application_acknowledgment_text.trim() || intendedUses.length === 0) {
      setErrorMessage("Enter the required notice version, public notice, acknowledgment, and at least one intended use.");
      return;
    }
    if (!Number.isInteger(draft.max_map_preferences) || draft.max_map_preferences < 0 || draft.max_map_preferences > 10) {
      setErrorMessage("Map preferences must be a whole number from 0 to 10.");
      return;
    }
    const activePhaseIds = new Set(settingsQuery.data!.phases.map((phase) => phase.id));
    if (draft.allowed_phase_ids.some((id) => !activePhaseIds.has(id))) {
      setErrorMessage("Remove any phase that is no longer active before saving.");
      return;
    }
    setErrorMessage(null);
    setMessage(null);
    setSaving(true);
    const next = { ...draft, allowed_intended_uses: intendedUses };
    const { error } = await supabase.rpc("save_project_application_settings", {
      p_tenant_id: tenantId,
      p_project_id: projectId,
      p_application_settings: next,
    });
    setSaving(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setDraft(next);
    setMessage("Project application settings saved. Map publication remains a separate action.");
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey: ["public-site-experience"] });
  }

  return (
    <Card className="v2-workflow-panel">
      <CardHeader><CardTitle>Project application settings</CardTitle></CardHeader>
      <CardContent className="grid gap-5">
        <p className="text-sm text-muted-foreground">Controls apply only to {workspace.projectName}. Effective intake also requires the existing tenant gate to be open. These settings do not publish a map.</p>
        {errorMessage ? <ErrorState message={errorMessage} /> : null}
        {message ? <p role="status" className="text-sm text-primary">{message}</p> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Application type">
            <Select aria-label="Application type" value={draft.application_type} disabled={!canManage || saving} onChange={(event) => update("application_type", event.target.value as ProjectApplicationDraft["application_type"])}>
              <option value="land_purchase">Land purchase</option>
              <option value="project_application">Project application</option>
            </Select>
          </Field>
          <label className="flex min-h-10 items-center gap-3 rounded-md border border-border px-3 text-sm font-medium">
            <input aria-label="Open this project’s intake gate" type="checkbox" checked={draft.applications_open} disabled={!canManage || saving} onChange={(event) => update("applications_open", event.target.checked)} />
            Open this project’s intake gate
          </label>
        </div>

        <fieldset className="grid gap-2" disabled={!canManage || saving}>
          <legend className="mb-2 text-sm font-semibold">Allowed phases</legend>
          {settingsQuery.data.phases.map((phase) => (
            <label key={phase.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <input aria-label={`Allowed phase ${phase.name} (${phase.slug})`} type="checkbox" checked={draft.allowed_phase_ids.includes(phase.id)} onChange={() => togglePhase(phase.id)} />
              <span>{phase.name}</span><span className="text-xs text-muted-foreground">{phase.slug}</span>
            </label>
          ))}
          {settingsQuery.data.phases.length === 0 ? <p className="text-sm text-muted-foreground">This project has no active phases.</p> : null}
        </fieldset>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Required notice version"><Input aria-label="Required notice version" value={draft.notice_version} maxLength={80} disabled={!canManage || saving} onChange={(event) => update("notice_version", event.target.value)} /></Field>
          <Field label="Maximum map outline preferences"><Input type="number" min={0} max={10} step={1} value={draft.max_map_preferences} disabled={!canManage || saving} onChange={(event) => update("max_map_preferences", Number(event.target.value))} /></Field>
        </div>
        <Field label="Public notice"><Textarea aria-label="Public notice" value={draft.public_notice_text} maxLength={5000} disabled={!canManage || saving} onChange={(event) => update("public_notice_text", event.target.value)} /></Field>
        <Field label="Applicant acknowledgment"><Textarea aria-label="Applicant acknowledgment" value={draft.application_acknowledgment_text} maxLength={2000} disabled={!canManage || saving} onChange={(event) => update("application_acknowledgment_text", event.target.value)} /></Field>
        <Field label="Allowed intended uses (one per line)"><Textarea aria-label="Allowed intended uses (one per line)" value={draft.allowed_intended_uses.join("\n")} disabled={!canManage || saving} onChange={(event) => update("allowed_intended_uses", event.target.value.split(/\r?\n/))} /></Field>
        <Field label="Application confirmation message"><Textarea aria-label="Application confirmation message" value={draft.default_confirmation_message} maxLength={500} disabled={!canManage || saving} onChange={(event) => update("default_confirmation_message", event.target.value)} /></Field>

        <section aria-labelledby="effective-project-intake" className="grid gap-3 rounded-lg border border-border p-4">
          <h3 id="effective-project-intake" className="font-semibold">Effective intake by phase</h3>
          <ul className="grid gap-2">
            {effectiveByPhase.map((phase) => (
              <li key={phase.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span>{phase.name}</span>
                <span className={phase.open ? "font-semibold text-secondary" : "font-semibold text-muted-foreground"}>{phase.open ? "Open" : `Closed · ${phase.reasons.join("; ") || "required settings incomplete"}`}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Open requires tenant intake, project intake, phase allowlisting, and complete required notices/form settings.</p>
        </section>
        <div><Button type="button" disabled={!canManage || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save project application settings"}</Button></div>
      </CardContent>
    </Card>
  );
}

function isPhase(value: unknown): value is Phase {
  const item = asRecord(value);
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.slug === "string";
}
