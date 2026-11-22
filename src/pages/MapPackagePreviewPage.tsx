import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPolygon, MapRasterLayer } from "../components/map/MapPolygon";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import type { MapFeature, MapFeatureSnapshot, ProjectMapPackage } from "../types/database";

type PreviewData = {
  packageRow: Pick<ProjectMapPackage, "id" | "snapshot_id" | "package_data" | "background_path" | "published_at">;
  snapshot: Pick<MapFeatureSnapshot, "id" | "snapshot_version" | "outline_count" | "is_active">;
  features: Array<Pick<MapFeature, "identity_id" | "demo_label" | "map_polygon" | "provenance">>;
  backgroundUrl: string | null;
};

type ReviewLinkRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  phase_id: string;
  package_id: string;
  snapshot_id: string;
  snapshot_version: number | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type CreatedReviewerLink = {
  id: string;
  url: string;
  tenant_id: string;
  project_id: string;
  phase_id: string;
  package_id: string;
  snapshot_id: string;
  snapshot_version: number;
};

type Coordinate = { x: number; y: number };

export function MapPackagePreviewPage() {
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState("86400");
  const [createdLink, setCreatedLink] = useState<CreatedReviewerLink | null>(null);
  const [linkActionPending, setLinkActionPending] = useState<string | null>(null);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const linkActionLock = useRef(false);
  const queryClient = useQueryClient();
  const sessionProfileQuery = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const canManageReviewLinks = ["Super Admin", "Admin"].includes(sessionProfileQuery.data?.profile?.role ?? "");
  const previewQuery = useQuery({
    queryKey: ["private-map-package-preview", workspace?.tenantId, workspace?.projectId, workspace?.phaseId],
    enabled: Boolean(workspace),
    retry: false,
    queryFn: async (): Promise<PreviewData | null> => {
      const { tenantId, projectId, phaseId } = workspace!;
      const packages = () => supabase.from("project_map_packages")
        .select("id,snapshot_id,package_data,background_path,published_at")
        .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId);
      const snapshots = () => supabase.from("map_feature_snapshots")
        .select("id,snapshot_version,outline_count,is_active")
        .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId);

      const draft = await packages()
        .is("published_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (draft.error) throw draft.error;
      let packageRow = draft.data;
      let publishedSnapshot: PreviewData["snapshot"] | null = null;

      if (!packageRow) {
        const active = await snapshots().eq("is_active", true).maybeSingle();
        if (active.error) throw active.error;
        if (!active.data) return null;

        const published = await packages()
          .eq("snapshot_id", active.data.id).not("published_at", "is", null).maybeSingle();
        if (published.error) throw published.error;
        if (!published.data) return null;
        packageRow = published.data;
        publishedSnapshot = active.data;
      }

      const features = supabase.from("map_features").select("identity_id,demo_label,map_polygon,provenance")
        .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
        .eq("snapshot_id", packageRow.snapshot_id).eq("is_active", true);
      const [snapshotResult, featuresResult] = await Promise.all([
        publishedSnapshot ? { data: publishedSnapshot, error: null } : snapshots().eq("id", packageRow.snapshot_id).single(),
        (publishedSnapshot ? features.eq("public_visible", true) : features).order("demo_label"),
      ]);
      if (snapshotResult.error) throw snapshotResult.error;
      if (featuresResult.error) throw featuresResult.error;
      let backgroundUrl: string | null = null;
      if (packageRow.background_path) {
        const { data, error } = await supabase.storage.from("project-map-packages")
          .createSignedUrl(packageRow.background_path, 60);
        if (error) throw error;
        backgroundUrl = data.signedUrl;
      }
      return {
        packageRow,
        snapshot: snapshotResult.data,
        features: featuresResult.data ?? [],
        backgroundUrl,
      };
    },
  });

  const draftPreview = previewQuery.data?.packageRow.published_at === null ? previewQuery.data : null;
  const linkScope = workspace ? {
    tenant_id: workspace.tenantId,
    project_id: workspace.projectId,
    phase_id: workspace.phaseId,
  } : null;
  const eligibleDraft = Boolean(draftPreview?.features.length
    && draftPreview.features.every((feature) => record(feature.provenance).reviewed === true));
  const linksQuery = useQuery({
    queryKey: ["project-map-review-links", linkScope?.tenant_id, linkScope?.project_id, linkScope?.phase_id],
    enabled: Boolean(linkScope && canManageReviewLinks),
    retry: false,
    queryFn: async (): Promise<ReviewLinkRow[]> => {
      const { data, error } = await supabase.functions.invoke("project-map-review-link", {
        body: { action: "list", ...linkScope },
      });
      if (error) throw new Error(await reviewLinkError(error));
      if (data?.error) throw new Error(String(data.error));
      const links = (data?.links ?? []) as ReviewLinkRow[];
      if (links.some((link) => link.tenant_id !== linkScope?.tenant_id
        || link.project_id !== linkScope?.project_id || link.phase_id !== linkScope?.phase_id)) {
        throw new Error("A reviewer link did not match the selected tenant, project, and phase.");
      }
      return links;
    },
  });

  async function createReviewerLink() {
    if (!linkScope || !draftPreview || !eligibleDraft || linkActionLock.current) return;
    linkActionLock.current = true;
    setLinkActionPending("create");
    setLinkActionError(null);
    setCreatedLink(null);
    setCopiedLink(false);
    const requestedRevision = {
      ...linkScope,
      package_id: draftPreview.packageRow.id,
      snapshot_id: draftPreview.snapshot.id,
      snapshot_version: draftPreview.snapshot.snapshot_version,
    };
    try {
      const { data, error } = await supabase.functions.invoke("project-map-review-link", {
        body: {
          action: "create", ...linkScope,
          package_id: draftPreview.packageRow.id,
          expires_in_seconds: Number(expiresInSeconds),
        },
      });
      if (error || data?.error || typeof data?.token !== "string") {
        setLinkActionError(error ? await reviewLinkError(error) : String(data?.error ?? "The signed review link could not be created."));
        return;
      }
      if (data.tenant_id !== requestedRevision.tenant_id
        || data.project_id !== requestedRevision.project_id
        || data.phase_id !== requestedRevision.phase_id
        || data.package_id !== requestedRevision.package_id
        || data.snapshot_id !== requestedRevision.snapshot_id
        || data.snapshot_version !== requestedRevision.snapshot_version
        || typeof data.link_id !== "string") {
        setLinkActionError("The server returned a reviewer link for a different map revision or workspace.");
        return;
      }
      setCreatedLink({
        id: data.link_id,
        url: `${window.location.origin}/review#${data.token}`,
        tenant_id: data.tenant_id,
        project_id: data.project_id,
        phase_id: data.phase_id,
        package_id: data.package_id,
        snapshot_id: data.snapshot_id,
        snapshot_version: data.snapshot_version,
      });
      await queryClient.invalidateQueries({ queryKey: ["project-map-review-links", linkScope.tenant_id, linkScope.project_id, linkScope.phase_id] });
    } catch (error) {
      setLinkActionError(error instanceof Error ? error.message : "The signed review link could not be created.");
    } finally {
      linkActionLock.current = false;
      setLinkActionPending(null);
    }
  }

  async function revokeReviewerLink(linkId: string) {
    if (!linkScope || linkActionLock.current) return;
    linkActionLock.current = true;
    setLinkActionPending(`revoke:${linkId}`);
    setLinkActionError(null);
    try {
      const { data, error } = await supabase.functions.invoke("project-map-review-link", {
        body: { action: "revoke", ...linkScope, link_id: linkId },
      });
      if (error || data?.error || data?.revoked !== true || data?.link_id !== linkId) {
        setLinkActionError(error ? await reviewLinkError(error) : String(data?.error ?? "The signed review link could not be revoked."));
        return;
      }
      if (createdLink?.id === linkId) setCreatedLink(null);
      await queryClient.invalidateQueries({ queryKey: ["project-map-review-links", linkScope.tenant_id, linkScope.project_id, linkScope.phase_id] });
    } catch (error) {
      setLinkActionError(error instanceof Error ? error.message : "The signed review link could not be revoked.");
    } finally {
      linkActionLock.current = false;
      setLinkActionPending(null);
    }
  }

  const mapPreview = previewQuery.data ?? null;
  const createdLinkMatchesCurrentRevision = Boolean(createdLink && workspace && mapPreview
    && createdLink.tenant_id === workspace.tenantId
    && createdLink.project_id === workspace.projectId
    && createdLink.phase_id === workspace.phaseId
    && createdLink.package_id === mapPreview.packageRow.id
    && createdLink.snapshot_id === mapPreview.snapshot.id
    && createdLink.snapshot_version === mapPreview.snapshot.snapshot_version);
  const reviewerLinksManager = canManageReviewLinks && linkScope && workspace ? (
    <section className="v2-workflow-panel grid gap-4 p-4" aria-labelledby="reviewer-link-heading">
      <div>
        <h2 id="reviewer-link-heading" className="font-semibold text-primary">Signed reviewer links for this phase</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}. Links stay bound to the map revision they were issued for.
        </p>
      </div>
      {draftPreview ? (
        <>
          <p className="text-sm text-muted-foreground">Create a read-only link for this exact reviewed revision and its current form settings. It is never used for public intake.</p>
          {!eligibleDraft ? (
            <p role="status" className="text-sm text-muted-foreground">Admin sign-off is required for every outline before a reviewer link can be issued.</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm font-medium" htmlFor="review-link-expiry">
              Link expires
              <select id="review-link-expiry" value={expiresInSeconds} onChange={(event) => setExpiresInSeconds(event.target.value)} className="min-h-10 rounded-md border bg-background px-3">
                <option value="60">In 1 minute</option>
                <option value="3600">In 1 hour</option>
                <option value="86400">In 24 hours</option>
                <option value="604800">In 7 days</option>
                <option value="2592000">In 30 days</option>
              </select>
            </label>
            <button type="button" onClick={() => void createReviewerLink()} disabled={!eligibleDraft || Boolean(linkActionPending)} className="min-h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
              {linkActionPending === "create" ? "Creating…" : "Create reviewer link"}
            </button>
          </div>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">Creating reviewer links is limited to eligible, reviewed drafts.</p>
      )}
      {createdLinkMatchesCurrentRevision && createdLink ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" data-review-link-binding={`${createdLink.tenant_id}:${createdLink.project_id}:${createdLink.phase_id}:${createdLink.snapshot_id}`}>
          <label className="grid gap-1 text-sm font-medium" htmlFor="new-review-link">
            Copy this signed link now · revision {createdLink.snapshot_version}
            <input id="new-review-link" aria-label="New signed reviewer link" readOnly value={createdLink.url} className="min-h-10 w-full rounded-md border bg-background px-3 font-normal" />
          </label>
          <button type="button" className="min-h-10 rounded-md border px-4 text-sm font-semibold" disabled={Boolean(linkActionPending)} onClick={() => {
            void navigator.clipboard.writeText(createdLink.url).then(() => setCopiedLink(true)).catch(() => setLinkActionError("Clipboard access was unavailable; select and copy the link manually."));
          }}>{copiedLink ? "Copied" : "Copy link"}</button>
        </div>
      ) : null}
      {linksQuery.error ? <p role="alert" className="text-sm text-red-700">{(linksQuery.error as Error).message}</p> : null}
      {linkActionError ? <p role="alert" className="text-sm text-red-700">{linkActionError}</p> : null}
      {linksQuery.data?.length ? (
        <ul className="grid gap-2" aria-label="Reviewer links for this phase">
          {linksQuery.data.map((link) => {
            const expired = Date.parse(link.expires_at) <= Date.now();
            return (
              <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm" data-review-link-id={link.id} data-review-link-revision={link.snapshot_version ?? "unknown"}>
                <span className="grid gap-1">
                  <span>
                    <strong>{link.revoked_at ? "Revoked" : expired ? "Expired" : "Active"}</strong>
                    <span className="ml-2 text-muted-foreground">Expires {new Date(link.expires_at).toLocaleString()}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {workspace.tenantName} · {workspace.projectName} · {workspace.phaseName} · revision {link.snapshot_version ?? "unavailable"} · snapshot {link.snapshot_id}
                  </span>
                </span>
                {!link.revoked_at && !expired ? (
                  <button type="button" onClick={() => void revokeReviewerLink(link.id)} disabled={Boolean(linkActionPending)} className="min-h-9 rounded-md border px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                    {linkActionPending === `revoke:${link.id}` ? "Revoking…" : "Revoke reviewer link"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : linksQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading reviewer-link status…</p> : <p className="text-sm text-muted-foreground">No reviewer links have been created for this phase.</p>}
      <p className="text-xs text-muted-foreground">Reviewers can view this map and form preview only. Revocation blocks future map and asset requests; the link does not grant Admin access or application submission.</p>
    </section>
  ) : null;

  if (workspaceLoading || previewQuery.isLoading) return <LoadingState label="Loading phase map" />;
  if (workspaceError) return <ErrorState message={workspaceError} />;
  if (!workspace) return <ErrorState message="Choose an assigned project and phase to preview its map." />;
  if (previewQuery.error) return <ErrorState message={(previewQuery.error as Error).message} />;
  if (!previewQuery.data) {
    return (
      <main className="v2-page-shell">
        <h1 className="v2-page-title">Map review</h1>
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
          No draft or published map is available for this phase.
        </p>
        {reviewerLinksManager}
      </main>
    );
  }

  const preview = previewQuery.data;
  const isPublished = !draftPreview;
  const selectedOutline = preview.features.find((feature) => feature.identity_id === selectedIdentityId);
  const canvas = record(preview.packageRow.package_data).canvas;
  const canvasData = record(canvas);
  const width = positiveNumber(canvasData.width) ?? 100;
  const height = positiveNumber(canvasData.height) ?? 100;

  return (
    <main className="v2-page-shell">
      <header className="v2-page-header">
        {!isPublished ? <p className="v2-page-kicker">Internal review · private to this assigned phase</p> : null}
        <h1 className="v2-page-title">{isPublished ? "Current published map" : "Private map preview"}</h1>
        <p className="v2-page-description">{workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}</p>
      </header>
      <div className="v2-workflow-panel grid gap-1 p-4 text-sm" role="status" aria-label="Map revision details">
        <p><strong>Map revision:</strong> {preview.snapshot.snapshot_version} · package revision {revision(preview.packageRow.package_data)}</p>
        <p><strong>Visibility:</strong> {isPublished ? "Published" : "Unpublished draft · visible to users assigned to this phase"}</p>
      </div>
      {reviewerLinksManager}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="overflow-hidden rounded-lg border bg-muted" aria-label={isPublished ? "Published phase map canvas" : "Private phase map canvas"}>
          <svg className="aspect-square w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={isPublished ? "Published phase map outlines" : "Unpublished phase map outlines"}>
            {preview.backgroundUrl ? <MapRasterLayer src={preview.backgroundUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" /> : null}
            {preview.features.map((feature) => {
              const coordinates = polygon(feature.map_polygon);
              if (coordinates.length < 3) return null;
              const isSelected = selectedIdentityId === feature.identity_id;
              return <MapPolygon
                key={feature.identity_id}
                coordinates={coordinates}
                role="button"
                tabIndex={0}
                aria-label={`Select outline ${feature.demo_label}`}
                aria-pressed={isSelected}
                onClick={() => setSelectedIdentityId(isSelected ? null : feature.identity_id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedIdentityId(isSelected ? null : feature.identity_id);
                  }
                }}
                fill={isSelected ? "rgba(45, 121, 86, 0.42)" : "rgba(255, 255, 255, 0.16)"}
                stroke={isSelected ? "#14532d" : "#ffffff"}
                strokeWidth={Math.max(width, height) / 250}
                className="cursor-pointer outline-none focus:stroke-[#14532d]"
                data-outline-id={feature.identity_id}
              />;
            })}
          </svg>
        </div>
        <aside className="v2-workflow-panel grid content-start gap-3 p-4">
          <h2 className="font-semibold text-primary">Choose an outline to review</h2>
          <p className="text-sm text-muted-foreground">The outline ID is a stable map identity. It is not saleable inventory.</p>
          {preview.features.map((feature) => (
            <button
              key={feature.identity_id}
              type="button"
              aria-pressed={selectedIdentityId === feature.identity_id}
              onClick={() => setSelectedIdentityId(selectedIdentityId === feature.identity_id ? null : feature.identity_id)}
              className="min-h-11 rounded-md border px-3 text-left text-sm font-medium hover:bg-primary-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              data-outline-id={feature.identity_id}
            >
              Select outline {feature.demo_label}
            </button>
          ))}
          <p role="status" aria-label="Selected outline">
            {selectedOutline
              ? `Selected outline ID ${selectedOutline.identity_id}`
              : "No outline selected"}
          </p>
        </aside>
      </div>
    </main>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function revision(value: unknown): string | number {
  const current = record(value).revision;
  return typeof current === "string" || typeof current === "number" ? current : "unknown";
}

function polygon(value: unknown): Coordinate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { x: number; y: number } =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).x === "number"
      && typeof (item as Record<string, unknown>).y === "number"))
    .map(({ x, y }) => ({ x, y }));
}

async function reviewLinkError(error: unknown): Promise<string> {
  const context = error && typeof error === "object" && "context" in error
    ? (error as { context?: Response }).context
    : undefined;
  if (context && typeof context.clone === "function") {
    const body = await context.clone().json().catch(() => ({}));
    if (typeof body?.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "The review-link request failed.";
}
