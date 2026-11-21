import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPolygon, MapRasterLayer } from "../components/map/MapPolygon";
import { ErrorState, LoadingState } from "../components/ui/State";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { getSessionAndProfile } from "../lib/data";
import { mapPolygonBounds, mapViewBoxString, type MapBounds } from "../lib/mapGeometry";
import { supabase } from "../lib/supabase";
import type { MapFeature, MapFeatureSnapshot, ProjectMapPackage } from "../types/database";

type PreviewData = {
  packageRow: Pick<ProjectMapPackage, "id" | "snapshot_id" | "package_data" | "background_path" | "published_at">;
  snapshot: Pick<MapFeatureSnapshot, "id" | "snapshot_version" | "outline_count" | "is_active">;
  features: PreviewOutline[];
  backgroundUrl: string | null;
};

type PreviewOutline = Pick<MapFeature, "identity_id" | "demo_label" | "map_polygon" | "provenance"> & {
  plot_number: string | null;
  lot_number: string | null;
};

type ReviewLinkRow = {
  id: string;
  package_id: string;
  snapshot_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type Coordinate = { x: number; y: number };

export function MapPackagePreviewPage() {
  const { choices, setPhase, workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [plotSearch, setPlotSearch] = useState("");
  const [outlinePage, setOutlinePage] = useState(0);
  const [focusedMapIdentityId, setFocusedMapIdentityId] = useState<string | null>(null);
  const [mapViewBounds, setMapViewBounds] = useState<MapBounds | null>(null);
  const [accessibleMapPhaseId, setAccessibleMapPhaseId] = useState("");
  const [expiresInSeconds, setExpiresInSeconds] = useState("86400");
  const [createdLink, setCreatedLink] = useState("");
  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
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

      const [snapshotResult, featureRows] = await Promise.all([
        publishedSnapshot ? { data: publishedSnapshot, error: null } : snapshots().eq("id", packageRow.snapshot_id).single(),
        loadScopedMapFeatures(tenantId, projectId, phaseId, packageRow.snapshot_id),
      ]);
      if (snapshotResult.error) throw snapshotResult.error;
      const plotContentRows = await loadScopedPlotContent(tenantId, projectId, phaseId);
      const contentByIdentity = new Map(plotContentRows.map((row) => [row.identity_id, row]));
      const hasParcelLinks = plotContentRows.some((row) => row.parcel_id !== null);
      const parcels = hasParcelLinks ? await loadScopedParcels(tenantId, projectId, phaseId) : [];
      const lotNumberByParcel = new Map(parcels.map((row) => [String(row.id), row.lot_number]));
      const features = featureRows.map((feature): PreviewOutline => {
        const content = contentByIdentity.get(feature.identity_id);
        return {
          ...feature,
          plot_number: content?.plot_number ?? null,
          lot_number: content?.parcel_id === null || content?.parcel_id === undefined
            ? null
            : lotNumberByParcel.get(String(content.parcel_id)) ?? null,
        };
      });
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
        features,
        backgroundUrl,
      };
    },
  });

  const mapAvailabilityQuery = useQuery({
    queryKey: ["map-review-accessible-phases-with-maps", choices.map((choice) => `${choice.tenantId}:${choice.projectId}:${choice.phaseId}`).sort()],
    enabled: choices.length > 0,
    retry: false,
    queryFn: async () => Promise.all(choices.map(async (choice) => {
      const [packages, activeSnapshot] = await Promise.all([
        supabase.from("project_map_packages").select("snapshot_id,published_at")
          .eq("tenant_id", choice.tenantId).eq("project_id", choice.projectId).eq("phase_id", choice.phaseId),
        supabase.from("map_feature_snapshots").select("id")
          .eq("tenant_id", choice.tenantId).eq("project_id", choice.projectId).eq("phase_id", choice.phaseId)
          .eq("is_active", true).maybeSingle(),
      ]);
      if (packages.error) throw packages.error;
      if (activeSnapshot.error) throw activeSnapshot.error;
      const hasDraft = (packages.data ?? []).some((row) => row.published_at === null);
      const hasActivePublication = Boolean(activeSnapshot.data
        && (packages.data ?? []).some((row) => row.snapshot_id === activeSnapshot.data?.id && row.published_at !== null));
      return { choice, hasMap: hasDraft || hasActivePublication };
    })),
  });

  useEffect(() => {
    setSelectedIdentityId(null);
    setFocusedMapIdentityId(null);
    setMapViewBounds(null);
    setOutlinePage(0);
    setPlotSearch("");
  }, [workspace?.tenantId, workspace?.projectId, workspace?.phaseId, previewQuery.data?.snapshot.id]);

  const draftPreview = previewQuery.data?.packageRow.published_at === null ? previewQuery.data : null;
  const linkScope = workspace && draftPreview ? {
    tenant_id: workspace.tenantId,
    project_id: workspace.projectId,
    phase_id: workspace.phaseId,
  } : null;
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
      return (data?.links ?? []) as ReviewLinkRow[];
    },
  });

  async function createReviewerLink() {
    if (!linkScope || !draftPreview) return;
    setLinkActionError(null);
    setCreatedLink("");
    setCopiedLink(false);
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
    setCreatedLink(`${window.location.origin}/review#${data.token}`);
    await queryClient.invalidateQueries({ queryKey: ["project-map-review-links", linkScope.tenant_id, linkScope.project_id, linkScope.phase_id] });
  }

  async function revokeReviewerLink(linkId: string) {
    if (!linkScope) return;
    setLinkActionError(null);
    const { data, error } = await supabase.functions.invoke("project-map-review-link", {
      body: { action: "revoke", ...linkScope, link_id: linkId },
    });
    if (error || data?.error || data?.revoked !== true) {
      setLinkActionError(error ? await reviewLinkError(error) : String(data?.error ?? "The signed review link could not be revoked."));
      return;
    }
    setCreatedLink("");
    await queryClient.invalidateQueries({ queryKey: ["project-map-review-links", linkScope.tenant_id, linkScope.project_id, linkScope.phase_id] });
  }

  if (workspaceLoading || previewQuery.isLoading) return <LoadingState label="Loading phase map" />;
  if (workspaceError) return <ErrorState message={workspaceError} />;
  if (!workspace) return <ErrorState message="Choose an assigned project and phase to preview its map." />;
  if (previewQuery.error) return <ErrorState message={(previewQuery.error as Error).message} />;
  if (!previewQuery.data) {
    const accessibleMapChoices = (mapAvailabilityQuery.data ?? [])
      .filter((result) => result.hasMap && result.choice.phaseId !== workspace.phaseId)
      .map((result) => result.choice);
    const selectedAccessiblePhaseId = accessibleMapChoices.some((choice) => choice.phaseId === accessibleMapPhaseId)
      ? accessibleMapPhaseId
      : accessibleMapChoices[0]?.phaseId ?? "";
    return (
      <main className="v2-page-shell">
        <header className="v2-page-header">
          <h1 className="v2-page-title">Map review</h1>
          <p className="v2-page-description">{workspace.tenantName} · {workspace.projectName} · {workspace.phaseName}</p>
        </header>
        <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">
          No draft or published map is available for this phase.
        </p>
        {mapAvailabilityQuery.error ? <p role="alert" className="text-sm text-red-700">Accessible map phases could not be loaded.</p> : null}
        {accessibleMapChoices.length ? (
          <section className="v2-workflow-panel grid gap-3 p-4" aria-labelledby="accessible-map-phase-heading">
            <div>
              <h2 id="accessible-map-phase-heading" className="font-semibold text-primary">Open an accessible phase with a map</h2>
              <p className="mt-1 text-sm text-muted-foreground">Only phases assigned to your account are listed.</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm font-medium" htmlFor="accessible-map-phase">
                Phase with a map
                <select id="accessible-map-phase" value={selectedAccessiblePhaseId} onChange={(event) => setAccessibleMapPhaseId(event.target.value)} className="min-h-10 rounded-md border bg-background px-3">
                  {accessibleMapChoices.map((choice) => (
                    <option key={choice.phaseId} value={choice.phaseId}>
                      {choice.tenantName} · {choice.projectName} · {choice.phaseName}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={!selectedAccessiblePhaseId} className="min-h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50" onClick={() => setPhase(selectedAccessiblePhaseId)}>
                Open phase map
              </button>
            </div>
          </section>
        ) : mapAvailabilityQuery.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">Checking your accessible phases for maps…</p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">No other accessible phase currently has a map.</p>
        )}
      </main>
    );
  }

  const preview = previewQuery.data;
  const isPublished = !draftPreview;
  const selectedOutline = preview.features.find((feature) => feature.identity_id === selectedIdentityId);
  const matchingFeatures = preview.features
    .filter((feature) => {
      const query = plotSearch.trim().toLocaleLowerCase();
      if (!query) return true;
      return [printedPlotLabel(feature), feature.demo_label, feature.identity_id, reviewStatus(feature), linkedLotLabel(feature)]
        .some((value) => value.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => printedPlotLabel(left).localeCompare(printedPlotLabel(right), undefined, { numeric: true, sensitivity: "base" }));
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(matchingFeatures.length / pageSize));
  const visibleFeatures = matchingFeatures.slice(outlinePage * pageSize, (outlinePage + 1) * pageSize);
  const canvas = record(preview.packageRow.package_data).canvas;
  const canvasData = record(canvas);
  const width = positiveNumber(canvasData.width) ?? 100;
  const height = positiveNumber(canvasData.height) ?? 100;
  const viewBounds = mapViewBounds ?? { x: 0, y: 0, width, height };

  function selectOutline(identityId: string) {
    const matchingIndex = matchingFeatures.findIndex((feature) => feature.identity_id === identityId);
    if (matchingIndex >= 0) {
      setOutlinePage(Math.floor(matchingIndex / pageSize));
    } else {
      const selected = preview.features.find((feature) => feature.identity_id === identityId);
      if (selected) setPlotSearch(printedPlotLabel(selected));
      setOutlinePage(0);
    }
    setSelectedIdentityId(identityId);
    setFocusedMapIdentityId(identityId);
  }

  function zoomToSelectedPlot() {
    if (!selectedOutline) return;
    const bounds = mapPolygonBounds(polygon(selectedOutline.map_polygon));
    if (!bounds) return;
    const minimumWidth = width / 12;
    const desiredWidth = Math.max(bounds.width * 1.8, bounds.height * 1.8 * width / height, minimumWidth);
    const viewWidth = Math.min(width, desiredWidth);
    const viewHeight = Math.min(height, viewWidth * height / width);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    setMapViewBounds({
      x: Math.max(0, Math.min(width - viewWidth, centerX - viewWidth / 2)),
      y: Math.max(0, Math.min(height - viewHeight, centerY - viewHeight / 2)),
      width: viewWidth,
      height: viewHeight,
    });
  }

  function handleMapOutlineKeyDown(event: React.KeyboardEvent<SVGPolygonElement>, index: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOutline(preview.features[index].identity_id);
      return;
    }
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (index + step + preview.features.length) % preview.features.length;
    const nextIdentityId = preview.features[nextIndex].identity_id;
    selectOutline(nextIdentityId);
    window.requestAnimationFrame(() => document.querySelector<SVGPolygonElement>(`polygon[data-outline-id="${nextIdentityId}"]`)?.focus());
  }

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
      {canManageReviewLinks && draftPreview ? (
        preview.features.length > 0 && preview.features.every((feature) => record(feature.provenance).reviewed === true) ? (
          <Link
            to={`/maps?packageId=${encodeURIComponent(draftPreview.packageRow.id)}`}
            className="inline-flex min-h-10 w-fit items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Continue to publish this reviewed package
          </Link>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">Review every outline before continuing to publication.</p>
        )
      ) : null}
      {canManageReviewLinks && draftPreview ? (
        <section className="v2-workflow-panel grid gap-4 p-4" aria-labelledby="reviewer-link-heading">
          <div>
            <h2 id="reviewer-link-heading" className="font-semibold text-primary">Signed reviewer link</h2>
            <p className="mt-1 text-sm text-muted-foreground">Create a read-only link for this exact reviewed revision and its current form settings. It is available before publication and never opens public intake.</p>
          </div>
          {!preview.features.length || !preview.features.every((feature) => record(feature.provenance).reviewed === true) ? (
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
            <button type="button" onClick={() => void createReviewerLink()} disabled={!preview.features.length || !preview.features.every((feature) => record(feature.provenance).reviewed === true)} className="min-h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
              Create reviewer link
            </button>
          </div>
          {createdLink ? (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="grid gap-1 text-sm font-medium" htmlFor="new-review-link">Copy this signed link now
                <input id="new-review-link" aria-label="New signed reviewer link" readOnly value={createdLink} className="min-h-10 w-full rounded-md border bg-background px-3 font-normal" />
              </label>
              <button type="button" className="min-h-10 rounded-md border px-4 text-sm font-semibold" onClick={() => {
                void navigator.clipboard.writeText(createdLink).then(() => setCopiedLink(true)).catch(() => setLinkActionError("Clipboard access was unavailable; select and copy the link manually."));
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
                  <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm" data-review-link-id={link.id}>
                    <span>
                      <strong>{link.revoked_at ? "Revoked" : expired ? "Expired" : "Active"}</strong>
                      <span className="ml-2 text-muted-foreground">Expires {new Date(link.expires_at).toLocaleString()}</span>
                    </span>
                    {!link.revoked_at && !expired ? <button type="button" onClick={() => void revokeReviewerLink(link.id)} className="min-h-9 rounded-md border px-3 font-semibold">Revoke reviewer link</button> : null}
                  </li>
                );
              })}
            </ul>
          ) : linksQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading reviewer-link status…</p> : <p className="text-sm text-muted-foreground">No reviewer links have been created for this phase.</p>}
          <p className="text-xs text-muted-foreground">Reviewers can view this map and form preview only. Revocation blocks future map and asset requests; the link does not grant Admin access or application submission.</p>
        </section>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="grid content-start gap-3" aria-label={isPublished ? "Published phase map canvas" : "Private phase map canvas"}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <p role="status" aria-label="Snapshot outline count">{preview.features.length} outlines in this map snapshot</p>
            {mapViewBounds ? <button type="button" className="min-h-9 rounded-md border bg-background px-3 font-medium text-primary" onClick={() => setMapViewBounds(null)}>Show full map</button> : null}
          </div>
          <div className="overflow-hidden rounded-lg border bg-muted">
            <svg className="aspect-square w-full" viewBox={mapViewBoxString(viewBounds)} role="group" aria-label={isPublished ? "Published phase map outlines" : "Unpublished phase map outlines"}>
              {preview.backgroundUrl ? <MapRasterLayer src={preview.backgroundUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" /> : null}
              {preview.features.map((feature, index) => {
                const coordinates = polygon(feature.map_polygon);
                if (coordinates.length < 3) return null;
                const isSelected = selectedIdentityId === feature.identity_id;
                const isFocused = focusedMapIdentityId === feature.identity_id || (!focusedMapIdentityId && index === 0);
                return <MapPolygon
                  key={feature.identity_id}
                  coordinates={coordinates}
                  role="button"
                  tabIndex={isFocused ? 0 : -1}
                  aria-label={`Select outline ${printedPlotLabel(feature)}`}
                  aria-pressed={isSelected}
                  onFocus={() => selectOutline(feature.identity_id)}
                  onClick={() => selectOutline(feature.identity_id)}
                  onKeyDown={(event) => handleMapOutlineKeyDown(event, index)}
                  fill={isSelected ? "rgba(45, 121, 86, 0.42)" : "rgba(255, 255, 255, 0.16)"}
                  stroke={isSelected ? "#14532d" : "#ffffff"}
                  strokeWidth={Math.max(width, height) / 250}
                  className="cursor-pointer outline-none focus:stroke-[#14532d]"
                  data-outline-id={feature.identity_id}
                />;
              })}
            </svg>
          </div>
        </section>
        <aside className="v2-workflow-panel grid content-start gap-4 p-4" aria-label="Plot search and selection">
          <section className="grid gap-3" aria-labelledby="plot-results-heading">
            <div>
              <h2 id="plot-results-heading" className="font-semibold text-primary">Find a plot</h2>
              <p className="mt-1 text-sm text-muted-foreground">Search the full map snapshot. The results list is paginated.</p>
            </div>
            <label className="grid gap-1 text-sm font-medium" htmlFor="plot-search">
              Search plots
              <input id="plot-search" type="search" value={plotSearch} onChange={(event) => {
                setPlotSearch(event.target.value);
                setOutlinePage(0);
              }} placeholder="Search plot number or lot" className="min-h-10 rounded-md border bg-background px-3 font-normal" />
            </label>
            <p role="status" aria-live="polite" aria-label="Plot search results" className="text-sm text-muted-foreground">
              {matchingFeatures.length} of {preview.features.length} outlines match
            </p>
            {visibleFeatures.length ? (
              <ol className="grid max-h-[28rem] gap-2 overflow-y-auto pr-1" aria-label="Plot results">
                {visibleFeatures.map((feature) => (
                  <li key={feature.identity_id}>
                    <button
                      type="button"
                      aria-pressed={selectedIdentityId === feature.identity_id}
                      onClick={() => selectOutline(feature.identity_id)}
                      className="grid min-h-12 w-full gap-1 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-primary-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      data-outline-id={feature.identity_id}
                    >
                      <span className="font-semibold">Select {printedPlotLabel(feature)}</span>
                      <span className="text-xs text-muted-foreground">{reviewStatus(feature)} · {linkedLotLabel(feature)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No plots match that search.</p>
            )}
            <div className="flex items-center justify-between gap-2 text-sm">
              <button type="button" disabled={outlinePage === 0} onClick={() => setOutlinePage((page) => Math.max(0, page - 1))} className="min-h-9 rounded-md border px-3 font-medium disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
              <span aria-label="Plot results page">Page {outlinePage + 1} of {pageCount}</span>
              <button type="button" disabled={outlinePage + 1 >= pageCount} onClick={() => setOutlinePage((page) => Math.min(pageCount - 1, page + 1))} className="min-h-9 rounded-md border px-3 font-medium disabled:cursor-not-allowed disabled:opacity-50">Next</button>
            </div>
          </section>
          <section className="grid gap-3 border-t pt-4" aria-labelledby="selected-plot-heading" aria-live="polite">
            <div>
              <h2 id="selected-plot-heading" className="font-semibold text-primary">Selected plot details</h2>
              <p className="mt-1 text-sm text-muted-foreground">Select a result or an outline on the map.</p>
            </div>
            {selectedOutline ? (
              <div role="status" aria-label="Selected plot">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                  <dt className="font-medium text-muted-foreground">Printed label</dt>
                  <dd className="font-semibold">{printedPlotLabel(selectedOutline)}</dd>
                  <dt className="font-medium text-muted-foreground">Review status</dt>
                  <dd>{reviewStatus(selectedOutline)}</dd>
                  <dt className="font-medium text-muted-foreground">Linked lot</dt>
                  <dd>{linkedLotLabel(selectedOutline)}</dd>
                </dl>
                <p className="mt-2 break-all text-xs text-muted-foreground">Outline ID {selectedOutline.identity_id}</p>
              </div>
            ) : (
              <p role="status" aria-label="Selected plot">No plot selected</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={!selectedOutline || polygon(selectedOutline.map_polygon).length < 3} onClick={zoomToSelectedPlot} className="min-h-10 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">Zoom to plot</button>
              {mapViewBounds ? <button type="button" onClick={() => setMapViewBounds(null)} className="min-h-10 rounded-md border px-3 text-sm font-medium">Show full map</button> : null}
            </div>
          </section>
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

const MAP_REVIEW_PAGE_SIZE = 500;

async function loadScopedMapFeatures(
  tenantId: string,
  projectId: string,
  phaseId: string,
  snapshotId: string,
): Promise<Array<Pick<MapFeature, "identity_id" | "demo_label" | "map_polygon" | "provenance">>> {
  const rows: Array<Pick<MapFeature, "identity_id" | "demo_label" | "map_polygon" | "provenance">> = [];
  for (let from = 0; ; from += MAP_REVIEW_PAGE_SIZE) {
    const { data, error } = await supabase.from("map_features").select("identity_id,demo_label,map_polygon,provenance")
      .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
      .eq("snapshot_id", snapshotId).order("demo_label").order("identity_id")
      .range(from, from + MAP_REVIEW_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < MAP_REVIEW_PAGE_SIZE) return rows;
  }
}

async function loadScopedPlotContent(tenantId: string, projectId: string, phaseId: string) {
  const rows: Array<{ identity_id: string; plot_number: string | null; parcel_id: number | null }> = [];
  for (let from = 0; ; from += MAP_REVIEW_PAGE_SIZE) {
    const { data, error } = await supabase.from("project_plot_content")
      .select("identity_id,plot_number,parcel_id")
      .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
      .order("identity_id").range(from, from + MAP_REVIEW_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < MAP_REVIEW_PAGE_SIZE) return rows;
  }
}

async function loadScopedParcels(tenantId: string, projectId: string, phaseId: string) {
  const rows: Array<{ id: number; lot_number: string }> = [];
  for (let from = 0; ; from += MAP_REVIEW_PAGE_SIZE) {
    const { data, error } = await supabase.from("parcels").select("id,lot_number")
      .eq("tenant_id", tenantId).eq("project_id", projectId).eq("phase_id", phaseId)
      .order("id").range(from, from + MAP_REVIEW_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < MAP_REVIEW_PAGE_SIZE) return rows;
  }
}

function printedPlotLabel(feature: Pick<PreviewOutline, "plot_number" | "demo_label">): string {
  return feature.plot_number?.trim() || feature.demo_label || "Unlabelled plot";
}

function linkedLotLabel(feature: Pick<PreviewOutline, "lot_number">): string {
  return feature.lot_number?.trim() ? `Lot ${feature.lot_number.trim()}` : "No linked lot";
}

function reviewStatus(feature: Pick<PreviewOutline, "provenance">): string {
  return record(feature.provenance).reviewed === true ? "Reviewed" : "Needs review";
}
