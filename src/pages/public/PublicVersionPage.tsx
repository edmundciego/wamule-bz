import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { loadPublicMapDiagnostics, type PublicMapDiagnosticsScope } from "../../lib/publicMapDiagnostics";
import { isHopkinsPublicHost } from "../../lib/publicHosts";

function currentScope(): PublicMapDiagnosticsScope {
  const query = new URLSearchParams(window.location.search);
  const queryScope = {
    tenantSlug: query.get("tenant") ?? "",
    projectSlug: query.get("project") ?? "",
    phaseSlug: query.get("phase") ?? "",
  };
  if (queryScope.tenantSlug && queryScope.projectSlug && queryScope.phaseSlug) return queryScope;
  const hopkinsRoute = isHopkinsPublicHost(window.location.hostname) || window.location.pathname.startsWith("/hopkins");
  return hopkinsRoute
    ? { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" }
    : { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" };
}

function valueOrUnavailable(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "Unavailable" : String(value);
}

export function PublicVersionPage() {
  const scope = currentScope();
  const mobileViewport = window.innerWidth < 768;
  const query = useQuery({
    queryKey: ["public-map-diagnostics", scope.tenantSlug, scope.projectSlug, scope.phaseSlug, mobileViewport ? "phone" : "desktop"],
    queryFn: () => loadPublicMapDiagnostics(scope, window.innerWidth),
    retry: false,
    staleTime: 0,
  });
  const build = __BUILD_INFO__;
  const backHref = scope.tenantSlug === "hopkins-grove" ? "/hopkins" : "/";

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-12">
      <div className="mx-auto grid max-w-3xl gap-6">
        <header className="grid gap-3">
          <Link to={backHref} className="w-fit text-sm font-semibold text-primary underline underline-offset-4">Back to public site</Link>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Build diagnostics</p>
          <h1 className="font-display text-3xl font-semibold text-primary">Version and map information</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Build metadata is compiled into this page. Map details come from the current public response scoped to one tenant, project, and phase.</p>
        </header>

        <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2" aria-label="Build information">
          <Diagnostic label="Commit" value={valueOrUnavailable(build.commit)} />
          <Diagnostic label="Uncommitted changes included" value={build.hasUncommittedChanges === null ? "Unavailable" : build.hasUncommittedChanges ? "Yes" : "No"} />
          <Diagnostic label="Build time" value={valueOrUnavailable(build.buildTime)} />
          <Diagnostic label="Build environment" value={valueOrUnavailable(build.environment)} />
        </section>

        <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2" aria-label="Scoped map information" aria-busy={query.isPending}>
          {query.isPending ? <p role="status" className="sm:col-span-2 text-sm text-muted-foreground">Loading scoped map information…</p> : null}
          {query.isError ? <p role="status" className="sm:col-span-2 text-sm text-muted-foreground">Map information is unavailable: {query.error instanceof Error ? query.error.message : "The scoped response could not be loaded."}</p> : null}
          <Diagnostic label="Tenant" value={query.data?.tenantName ?? null} />
          <Diagnostic label="Project" value={query.data?.projectName ?? null} />
          <Diagnostic label="Phase" value={query.data?.phaseName ?? null} />
          <Diagnostic label="Active masterplan version ID" value={query.data?.activeMasterplanVersionId ?? null} />
          <Diagnostic label="Loaded map outlines" value={query.data?.loadedOutlineCount ?? null} />
          <Diagnostic label="Displayed image dimensions" value={query.data?.imageWidth && query.data.imageHeight ? `${query.data.imageWidth} × ${query.data.imageHeight}px` : null} />
          <Diagnostic label="Displayed image URL" value={query.data?.displayedImageUrl ?? null} className="sm:col-span-2 break-all" />
          {mobileViewport && query.data && !query.data.phonePreviewUrl ? (
            <p className="sm:col-span-2 rounded-md border border-border bg-muted/35 p-3 text-xs leading-5 text-muted-foreground">No phone-specific preview was returned. This viewport uses the full masterplan image.</p>
          ) : null}
          {query.data?.phonePreviewUrl ? <Diagnostic label="Phone preview URL" value={query.data.phonePreviewUrl} className="sm:col-span-2 break-all" /> : null}
        </section>
        <p className="text-xs leading-5 text-muted-foreground">Image URLs omit query parameters. No credentials or applicant details are displayed.</p>
      </div>
    </main>
  );
}

function Diagnostic({ label, value, className = "" }: { label: string; value: string | number | null; className?: string }) {
  return (
    <div className={`min-w-0 rounded-lg bg-muted/35 p-3 ${className}`}>
      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-foreground">{valueOrUnavailable(value)}</dd>
    </div>
  );
}
