import { ArrowUpRight, ClipboardList, Layers3, Map } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MasterplanUpload } from "../components/admin/settings/MasterplanUpload";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { getSessionAndProfile } from "../lib/data";

export function MapsPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const { data: sessionProfile } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const canManage = sessionProfile?.profile?.role === "Super Admin" || sessionProfile?.profile?.role === "Admin";

  if (workspaceLoading) return <LoadingState label="Loading map workspace" />;
  if (workspaceError) return <ErrorState message={workspaceError} />;
  if (!workspace) return <ErrorState message="Select a verified project and phase workspace to manage its map." />;

  const mapPath = `/embed/${encodeURIComponent(workspace.tenantSlug)}/${encodeURIComponent(workspace.projectSlug)}?phase=${encodeURIComponent(workspace.phaseSlug)}`;

  return (
    <div className="mx-auto grid max-w-[1520px] gap-6 p-4 sm:p-6">
      <header>
        <p className="v2-page-kicker">Workspace map</p>
        <h1 className="v2-page-title">Maps</h1>
        <p className="v2-page-description">{workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}. Map revisions and backgrounds are phase scoped; stable outline identities are retained across revisions.</p>
      </header>

      <Card>
        <CardHeader><CardTitle>Phase map background and revisions</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">Manage the aerial background and inspect retained map versions. A published outline is a map reference until it is separately linked to verified saleable inventory.</p>
          <MasterplanUpload
            tenantId={workspace.tenantId}
            projectId={workspace.projectId}
            phaseId={workspace.phaseId}
            projectName={workspace.projectName}
            phaseName={workspace.phaseName}
            isDefaultScope={Boolean(workspace.isDefaultProject && workspace.isDefaultPhase)}
            canManage={canManage}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Map className="h-4 w-4" /> Published map</CardTitle></CardHeader><CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">Open the public map resolved to this project and phase.</p>
          <Link className="inline-flex min-h-10 w-fit items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft" to={mapPath} target="_blank" rel="noreferrer">Preview map <ArrowUpRight className="h-4 w-4" /></Link>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Layers3 className="h-4 w-4" /> Saleable inventory and pricing</CardTitle></CardHeader><CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">Open the existing tier catalogue. These saleable-inventory prices stay distinct from source-plan reference prices shown on the Hopkins public map.</p>
          <Link className="inline-flex min-h-10 w-fit items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft" to="/lots?tab=tiers">Manage tier catalogue <ArrowUpRight className="h-4 w-4" /></Link>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><ClipboardList className="h-4 w-4" /> Applications</CardTitle></CardHeader><CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">Review project applications and the selected stable map outline IDs in this workspace.</p>
          <Link className="inline-flex min-h-10 w-fit items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-semibold text-primary hover:bg-primary-soft" to="/applications">Open applications <ArrowUpRight className="h-4 w-4" /></Link>
        </CardContent></Card>
      </div>
      {canManage ? null : <p className="text-xs text-muted-foreground">Map and pricing changes are limited to Admin and Super Admin roles. The workspace’s existing database permissions remain authoritative.</p>}
    </div>
  );
}
