import { useEffect, useState } from "react";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { ErrorState } from "../../ui/State";
import { resolvePublicHostname } from "../../../lib/publicHostResolver";

type EmbedFilter = "all" | "available";

const HEIGHT_PRESETS = ["500px", "700px", "900px"];
const RADIUS_OPTIONS = ["0px", "8px", "12px", "20px"];

export function WordPressEmbedSnippet({ tenantSlug, projectSlug, phaseSlug }: { tenantSlug: string | null; projectSlug: string | null; phaseSlug: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState("700px");
  const [radius, setRadius] = useState("12px");
  const [filter, setFilter] = useState<EmbedFilter>("available");
  const [copied, setCopied] = useState(false);
  const [hostReady, setHostReady] = useState(false);
  const [hostChecking, setHostChecking] = useState(true);

  useEffect(() => {
    setError(null);
    let cancelled = false;
    setHostReady(false);
    if (!tenantSlug || !projectSlug) {
      setHostChecking(false);
      return () => { cancelled = true; };
    }
    setHostChecking(true);
    void resolvePublicHostname(window.location.hostname).then((resolution) => {
      if (cancelled) return;
      setHostReady(resolution.resolved
        && resolution.scope.tenantSlug === tenantSlug
        && resolution.scope.projectSlug === projectSlug);
      setHostChecking(false);
    }).catch(() => {
      if (!cancelled) {
        setHostReady(false);
        setHostChecking(false);
      }
    });
    return () => { cancelled = true; };
  }, [tenantSlug, projectSlug, phaseSlug]);

  const baseUrl = window.location.origin;
  const projectPath = projectSlug ? encodeURIComponent(projectSlug) : "";
  const phasePath = phaseSlug ? encodeURIComponent(phaseSlug) : "";
  const mapPath = tenantSlug && projectPath && phasePath && hostReady
    ? `/embed/${encodeURIComponent(tenantSlug)}/${projectPath}?phase=${phasePath}&filter=${filter}`
    : "";
  const snippet = tenantSlug && mapPath
    ? `<iframe src="${baseUrl}${mapPath}" width="100%" height="${height}" frameborder="0" style="border:0; border-radius:${radius}; width:100%; overflow:hidden;" allowfullscreen allow="fullscreen"></iframe>`
    : "";

  async function handleCopy() {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed. Select the code manually.");
    }
  }

  return (
    <div className="grid gap-4">
      {error ? <ErrorState message={error} /> : null}
      {(!tenantSlug || !projectSlug || !phaseSlug) && !error ? (
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
          Embed details appear once your login is linked to a tenant, project and phase.
        </p>
      ) : null}
      {tenantSlug && projectSlug && phaseSlug && !hostReady && !hostChecking ? (
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground" role="status">
          This address is not an active public binding for the selected project. Open the admin app on that project&apos;s verified public hostname before copying an embed snippet.
        </p>
      ) : null}
      {hostChecking && tenantSlug && projectSlug ? <p className="text-sm text-muted-foreground" role="status">Checking this public host binding…</p> : null}
      {tenantSlug && projectSlug && phaseSlug && hostReady ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Height">
              <Select value={height} onChange={(event) => setHeight(event.target.value)}>
                {HEIGHT_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>{preset}</option>
                ))}
              </Select>
            </Field>
            <Field label="Border radius">
              <Select value={radius} onChange={(event) => setRadius(event.target.value)}>
                {RADIUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </Field>
            <Field label="Default view">
              <Select value={filter} onChange={(event) => setFilter(event.target.value as EmbedFilter)}>
                <option value="all">All lots</option>
                <option value="available">Available only</option>
              </Select>
            </Field>
            <Field label="Workspace scope">
              <Input readOnly value={`${projectSlug ?? "No project"} / ${phaseSlug ?? "No phase"}`} />
            </Field>
          </div>
          <Field label="Custom height (optional override)">
            <Input
              value={height}
              onChange={(event) => setHeight(event.target.value)}
              placeholder="700px"
              maxLength={12}
            />
          </Field>
          <Field label="Embed code — paste into a WordPress Custom HTML block">
            <textarea
              readOnly
              value={snippet}
              rows={6}
              onFocus={(event) => event.target.select()}
              className="focus-ring w-full min-w-0 max-w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs shadow-sm"
            />
          </Field>
          <div>
            <Button type="button" disabled={!snippet} onClick={() => void handleCopy()}>
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Live map for tenant <strong>{tenantSlug}</strong>, project <strong>{projectSlug}</strong>, phase <strong>{phaseSlug}</strong>. The selected phase is part of the generated link. Works in WordPress, Webflow, or any site that accepts iframes.
            Inquiries submitted inside the embed route to your tenant pipeline automatically.
            The snippet allows fullscreen mode; older embeds need <code>allow=&quot;fullscreen&quot;</code> added to the iframe tag for it to work.
          </p>
        </>
      ) : null}
    </div>
  );
}
