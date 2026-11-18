import { useState } from "react";
import { ArrowUpRight, Copy } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import type { WorkspaceChoice } from "../../auth/workspaceScopeContext";
import { buildSharedProjectLinks } from "../../../lib/sharedProjectLinks.mjs";

export function SharedProjectLinks({ workspace }: { workspace: WorkspaceChoice | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!workspace) return null;
  const links = buildSharedProjectLinks(window.location.origin, workspace);

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`${label} link copied.`);
    } catch {
      setCopied("Clipboard access is unavailable. Select and copy the link from its field.");
    }
  }

  return (
    <Card className="v2-workflow-panel">
      <CardHeader><CardTitle>Shared project links</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">These links use the selected workspace slugs and work without hostname bindings.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium">
            <span>Project application</span>
            <Input readOnly value={links.projectUrl} aria-label="Shared project application link" onFocus={(event) => event.currentTarget.select()} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void copy("Project", links.projectUrl)}><Copy className="h-4 w-4" />Copy link</Button>
              <Link className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft" to={`${new URL(links.projectUrl).pathname}${new URL(links.projectUrl).search}`} target="_blank" rel="noreferrer">Open <ArrowUpRight className="h-4 w-4" /></Link>
            </div>
          </label>
          <label className="grid gap-2 text-sm font-medium">
            <span>Project map</span>
            <Input readOnly value={links.mapUrl} aria-label="Shared project map link" onFocus={(event) => event.currentTarget.select()} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void copy("Map", links.mapUrl)}><Copy className="h-4 w-4" />Copy link</Button>
              <Link className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft" to={`${new URL(links.mapUrl).pathname}${new URL(links.mapUrl).search}`} target="_blank" rel="noreferrer">Open <ArrowUpRight className="h-4 w-4" /></Link>
            </div>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}</p>
        {copied ? <p role="status" className="text-sm text-primary">{copied}</p> : null}
      </CardContent>
    </Card>
  );
}
