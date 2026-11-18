import { useEffect, useState } from "react";
import { MapPolygon, MapRasterLayer } from "../components/map/MapPolygon";

type Coordinate = { x: number; y: number };
type ReviewerFeature = { identity_id: string; demo_label: string; map_polygon: unknown };
type ReviewerMap = {
  scope: {
    tenant_name: string;
    project_name: string;
    phase_name: string;
    phase_slug: string;
    template_id: string;
    application_type: string;
    public_application: {
      applications_open: boolean;
      notices_complete: boolean;
      public_notice_text: string;
      application_acknowledgment_text: string;
      notice_version: string;
      intended_uses: string[];
      max_map_preferences: number;
      confirmation_message: string;
    };
  };
  revision: { snapshot_id: string; snapshot_version: number; package_id: string; package_digest: string };
  canvas: { width: number; height: number; package_revision: string | number };
  background_available: boolean;
  features: ReviewerFeature[];
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function MapReviewerLinkPage() {
  const [map, setMap] = useState<ReviewerMap | null>(null);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const previousTitle = document.title;
    const previousRobots = ensureMeta("robots", "noindex, nofollow, noarchive, nosnippet");
    const previousReferrer = ensureMeta("referrer", "no-referrer");
    let objectUrl: string | null = null;
    let cancelled = false;
    const token = window.location.hash.slice(1);

    async function load() {
      try {
        if (!token || !supabaseUrl || !anonKey) throw new Error("This reviewer link is invalid or unavailable.");
        const data = await reviewerRequest<ReviewerMap>("resolve", token);
        if (cancelled) return;
        setMap(data);
        document.title = `Map review · ${data.scope.project_name}`;
        if (data.background_available) {
          const response = await reviewerAsset(token);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(await response.blob());
          setBackgroundUrl(objectUrl);
        }
      } catch {
        if (!cancelled) setError("This reviewer link has expired, been revoked, or is unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      document.title = previousTitle;
      restoreMeta("robots", previousRobots);
      restoreMeta("referrer", previousReferrer);
    };
  }, []);

  if (loading) return <main className="grid min-h-screen place-items-center px-4" role="status">Loading private map review…</main>;
  if (error || !map) return <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-3 px-5 text-center"><h1 className="font-display text-2xl font-semibold">Review link unavailable</h1><p role="alert" className="text-sm text-muted-foreground">{error ?? "This reviewer link is unavailable."}</p></main>;

  const selectedFeature = map.features.find((feature) => feature.identity_id === selectedIdentityId) ?? null;
  const width = positiveNumber(map.canvas.width) ?? 100;
  const height = positiveNumber(map.canvas.height) ?? 100;

  return (
    <main className="mx-auto grid min-h-screen max-w-[1440px] gap-6 px-4 py-6 sm:px-6" data-reviewer-surface="read-only">
      <header className="grid gap-2">
        <p className="v2-page-kicker">Private reviewer access · read only</p>
        <h1 className="v2-page-title">{map.scope.project_name} map review</h1>
        <p className="v2-page-description">{map.scope.tenant_name} · {map.scope.phase_name}</p>
        <div className="rounded-md border bg-muted/40 p-3 text-sm" role="status" aria-label="Reviewed map revision">
          <p>Map revision: {map.revision.snapshot_version} · package revision {map.canvas.package_revision}</p>
          <p>Application form: {map.scope.application_type === "project_application" ? "Project application" : "Land purchase application"}</p>
          <p>Public intake: {map.scope.public_application.applications_open ? "Controlled by the existing phase gate" : "Closed"}</p>
        </div>
      </header>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]" aria-label="Read-only map and form preview">
        <div className="overflow-hidden rounded-lg border bg-muted" aria-label="Reviewed map canvas">
          <svg className="aspect-square w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Reviewed project map outlines">
            {backgroundUrl ? <MapRasterLayer src={backgroundUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" /> : null}
            {map.features.map((feature) => {
              const coordinates = polygon(feature.map_polygon);
              if (coordinates.length < 3) return null;
              const selected = selectedIdentityId === feature.identity_id;
              return <MapPolygon
                key={feature.identity_id}
                coordinates={coordinates}
                role="button"
                tabIndex={0}
                aria-label={`Select outline ${feature.demo_label}`}
                aria-pressed={selected}
                onClick={() => setSelectedIdentityId(selected ? null : feature.identity_id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedIdentityId(selected ? null : feature.identity_id);
                  }
                }}
                fill={selected ? "rgba(45, 121, 86, 0.42)" : "rgba(255, 255, 255, 0.16)"}
                stroke={selected ? "#14532d" : "#ffffff"}
                strokeWidth={Math.max(width, height) / 250}
                className="cursor-pointer outline-none focus:stroke-[#14532d]"
                data-outline-id={feature.identity_id}
              />;
            })}
          </svg>
        </div>
        <aside className="grid content-start gap-4">
          <div className="v2-workflow-panel grid gap-3 p-4">
            <h2 className="font-semibold text-primary">Select an outline</h2>
            <p className="text-sm text-muted-foreground">This review is limited to the approved map revision shown above. Selection is a preview only.</p>
            {map.features.map((feature) => (
              <button key={feature.identity_id} type="button" aria-pressed={selectedIdentityId === feature.identity_id}
                onClick={() => setSelectedIdentityId(selectedIdentityId === feature.identity_id ? null : feature.identity_id)}
                className="min-h-11 rounded-md border px-3 text-left text-sm font-medium hover:bg-primary-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                data-outline-id={feature.identity_id}>
                Select outline {feature.demo_label}
              </button>
            ))}
            <p role="status" aria-label="Selected outline">{selectedFeature ? `Selected outline ID ${selectedFeature.identity_id}` : "No outline selected"}</p>
          </div>

          <form className="v2-workflow-panel grid gap-4 p-4" aria-label="Read-only application form preview">
            <div>
              <h2 className="font-semibold text-primary">Application form preview</h2>
              <p className="mt-1 text-sm text-muted-foreground">Review-only fields. This link cannot submit an application.</p>
            </div>
            {map.scope.public_application.public_notice_text ? <p className="rounded-md bg-muted/50 p-3 text-sm">{map.scope.public_application.public_notice_text}</p> : null}
            <fieldset disabled className="grid gap-3">
              <legend className="text-sm font-medium">{map.scope.application_type === "project_application" ? "Project application" : "Land purchase application"}</legend>
              <PreviewField label="Full name" />
              {map.scope.application_type === "project_application" ? <>
                <PreviewField label="Nationality" />
                <PreviewField label="Occupation" />
                <PreviewSelect label="Intended project use" options={map.scope.public_application.intended_uses} />
                <PreviewField label="Mailing address" />
                <PreviewField label={`Optional map-outline interests · up to ${map.scope.public_application.max_map_preferences}`} value={selectedFeature ? `${selectedFeature.demo_label} · ${selectedFeature.identity_id}` : "Select an outline to preview this field"} />
              </> : <>
                <PreviewField label="Address" />
                <PreviewSelect label="Intended use" options={map.scope.public_application.intended_uses} />
                <PreviewField label="Preferred lot" value={selectedFeature ? `${selectedFeature.demo_label} · ${selectedFeature.identity_id}` : "Select an outline to preview this field"} />
                <PreviewField label="Payment preference" />
              </>}
              <PreviewField label="Phone / WhatsApp" />
              <PreviewField label="Email address" />
              <PreviewField label="Applicant acknowledgement" value={map.scope.public_application.application_acknowledgment_text || "Acknowledgement text is not configured."} />
              <label className="flex gap-2 text-sm"><input type="checkbox" /> I have read the project notice and application terms.</label>
            </fieldset>
          </form>
        </aside>
      </section>
      <p className="text-xs text-muted-foreground">This page is private to its signed reviewer link. It does not grant workspace, Admin, or application-submission access.</p>
    </main>
  );
}

function PreviewField({ label, value = "" }: { label: string; value?: string }) {
  return <label className="grid gap-1 text-sm">{label}<input disabled value={value} placeholder="Preview field" className="min-h-10 rounded-md border bg-background px-3" /></label>;
}

function PreviewSelect({ label, options }: { label: string; options: string[] }) {
  return <label className="grid gap-1 text-sm">{label}<select disabled defaultValue="" className="min-h-10 rounded-md border bg-background px-3"><option value="">Choose an option</option>{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
}

async function reviewerRequest<T>(action: string, token: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${supabaseUrl}/functions/v1/project-map-review-link`, {
    method: "POST",
    headers: { apikey: anonKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ action, token, ...extra }),
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.error ?? "Review link unavailable"));
  return data as T;
}

async function reviewerAsset(token: string): Promise<Response> {
  const response = await fetch(`${supabaseUrl}/functions/v1/project-map-review-link`, {
    method: "POST",
    headers: { apikey: anonKey!, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "asset", token }),
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("Review background unavailable");
  return response;
}

function ensureMeta(name: string, content: string): { element: HTMLMetaElement; existed: boolean; content: string } {
  const existing = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const element = existing ?? document.createElement("meta");
  const previous = { element, existed: Boolean(existing), content: existing?.content ?? "" };
  element.name = name;
  element.content = content;
  if (!existing) document.head.append(element);
  return previous;
}

function restoreMeta(name: string, previous: { element: HTMLMetaElement; existed: boolean; content: string }) {
  if (previous.existed) previous.element.content = previous.content;
  else if (previous.element.name === name) previous.element.remove();
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function polygon(value: unknown): Coordinate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { x: number; y: number } => Boolean(item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).x === "number" && typeof (item as Record<string, unknown>).y === "number"))
    .map(({ x, y }) => ({ x, y }));
}
