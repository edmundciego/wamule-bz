import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUpRight, CheckCircle2, MapPin, Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { PublicInquiryPanel } from "../ApplicationPage";
import { PublicLotMap, type PublicLotParcel } from "../../components/public/PublicLotMap";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Field, Input, Select, Textarea } from "../../components/ui/Field";
import { ErrorState, LoadingState } from "../../components/ui/State";
import { WamuleClassicHeader, WamuleClassicHero, WamuleClassicInfoTile, WamuleClassicNotice, WamuleClassicPanel } from "../../components/public/WamuleClassicTemplate";
import { buildInquiryPayload } from "../../../supabase/functions/_shared/inquiry-contract";
import { buildHopkinsProjectApplicationPayload } from "../../../supabase/functions/_shared/hopkins-project-application-contract.mjs";
import { isHopkinsPublicHost } from "../../lib/publicHosts";
import { hasSupabaseConfig } from "../../lib/supabase";
import { submitPublicFunction } from "../../lib/publicSubmission";
import { defaultPublicExperience, type PublicSiteModuleId, type PublicSiteTemplateId } from "../../lib/publicExperience.mjs";
import { usePublicSiteExperience } from "../../lib/publicSiteExperience";

const HOPKINS_SCOPE = { tenant: "hopkins-grove", project: "hopkins-grove", phase: "initial" } as const;
const HOPKINS_SITE_SCOPE = { tenantSlug: "hopkins-grove", projectSlug: "hopkins-grove", phaseSlug: "initial" } as const;
const MAP_URL = "/embed/hopkins-grove/hopkins-grove?phase=initial";

type PublicProjectPage = {
  tenant: { name: string; slug: string };
  project: { name: string; slug: string; mapExperienceMode: "sales" | "demo" };
  phase: { name: string; slug: string };
  company: {
    name: string;
    email: string;
    phone: string;
    website: string;
    location: string;
    description: string;
    publicNotice: string;
  };
  applicationSettings: {
    applicationsOpen: boolean;
    noticeVersion: string;
    publicNotice: string;
    acknowledgmentText: string;
    intendedUses: string[];
    maxMapPreferences: number;
    confirmationMessage: string;
  };
};

function fallbackUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Continue with a standards-shaped fallback for older browsers.
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function loadPublicProjectPage(): Promise<PublicProjectPage> {
  const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!baseUrl || !anonKey) throw new Error("The public project page is not configured.");

  const response = await fetch(`${baseUrl}/functions/v1/get-public-project-page`, {
    method: "GET",
    headers: { apikey: anonKey, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as PublicProjectPage & { error?: string };
  if (!response.ok || body.tenant?.slug !== HOPKINS_SCOPE.tenant
    || body.project?.slug !== HOPKINS_SCOPE.project || body.phase?.slug !== HOPKINS_SCOPE.phase
    || !body.company?.name || !body.company?.email || !body.company?.publicNotice
    || !body.applicationSettings?.noticeVersion || !body.applicationSettings?.publicNotice
    || !body.applicationSettings?.acknowledgmentText || !Array.isArray(body.applicationSettings?.intendedUses)) {
    throw new Error(body.error || "Hopkins public information could not be verified.");
  }
  return body;
}

export function HopkinsPublicPage({
  templateId: selectedTemplate,
  enabledModules: selectedModules,
}: {
  templateId?: PublicSiteTemplateId;
  enabledModules?: Record<PublicSiteModuleId, boolean>;
} = {}) {
  const location = useLocation();
  const { data: siteExperience } = usePublicSiteExperience(HOPKINS_SITE_SCOPE);
  const experience = siteExperience ?? defaultPublicExperience(HOPKINS_SITE_SCOPE);
  const templateId = selectedTemplate ?? experience.templateId;
  const modules = selectedModules ?? experience.enabledModules;
  const { data: page, isLoading, isError, error } = useQuery({
    queryKey: ["public-project-page", HOPKINS_SCOPE.tenant, HOPKINS_SCOPE.project, HOPKINS_SCOPE.phase],
    queryFn: loadPublicProjectPage,
    enabled: hasSupabaseConfig,
    retry: false,
    staleTime: 60_000,
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState(fallbackUuid);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [selectedMapFeatureRefs, setSelectedMapFeatureRefs] = useState<string[]>([]);
  const [mapFeatureLabels, setMapFeatureLabels] = useState<Array<{ ref: string; label: string }>>([]);
  const [mapPreferenceError, setMapPreferenceError] = useState<string | null>(null);

  useEffect(() => {
    const priorTitle = document.title;
    const descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const applicationMeta = document.querySelector<HTMLMetaElement>('meta[name="application-name"]');
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const priorDescription = descriptionMeta?.content;
    const priorApplicationName = applicationMeta?.content;
    const priorTheme = themeMeta?.content;
    const iconLinks = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
    const priorIcons = iconLinks.map((link) => link.href);
    document.title = "Hopkins Grove | Ceiba Realty & Development";
    if (descriptionMeta) descriptionMeta.content = "Explore the Hopkins Grove project map and contact Ceiba Realty & Development for current information.";
    if (applicationMeta) applicationMeta.content = "Hopkins Grove";
    if (themeMeta) themeMeta.content = "#173f2d";
    iconLinks.forEach((link) => { link.href = "/favicon/hopkins-grove.svg"; });
    return () => {
      document.title = priorTitle;
      if (descriptionMeta && priorDescription !== undefined) descriptionMeta.content = priorDescription;
      if (applicationMeta && priorApplicationName !== undefined) applicationMeta.content = priorApplicationName;
      if (themeMeta && priorTheme !== undefined) themeMeta.content = priorTheme;
      iconLinks.forEach((link, index) => { link.href = priorIcons[index] ?? link.href; });
    };
  }, []);

  useEffect(() => {
    if (!page) return;
    if (location.pathname === "/hopkins/application") {
      const applicationTarget = templateId === "wamule-classic" && modules.map ? "application-map" : "application";
      window.requestAnimationFrame(() => document.getElementById(applicationTarget)?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    if (location.pathname !== "/hopkins/apply" && !(isHopkinsPublicHost(window.location.hostname) && location.pathname === "/apply")) return;
    window.requestAnimationFrame(() => document.getElementById("interest")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [location.pathname, page, templateId, modules.map]);

  function toggleMapFeature(parcel: PublicLotParcel) {
    const ref = parcel.map_feature_ref;
    if (!ref) return;
    setMapPreferenceError(null);
    if (selectedMapFeatureRefs.includes(ref)) {
      setSelectedMapFeatureRefs((current) => current.filter((item) => item !== ref));
      return;
    }
    const limit = page?.applicationSettings.maxMapPreferences ?? 5;
    if (selectedMapFeatureRefs.length >= limit) {
      setMapPreferenceError(`Choose no more than ${limit} map outlines.`);
      return;
    }
    setSelectedMapFeatureRefs((current) => current.includes(ref) ? current : [...current, ref]);
  }

  async function submitInterest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await submitPublicFunction("submit-public-inquiry", buildInquiryPayload({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          interests: ["General project interest"],
          message: message.trim() || undefined,
          pageUrl: window.location.href,
          tenant: HOPKINS_SCOPE.tenant,
          project: HOPKINS_SCOPE.project,
          phase: HOPKINS_SCOPE.phase,
          clientReferenceId: requestId,
        }));
      setSubmitted(true);
    } catch (submitFailure) {
      setSubmitError(submitFailure instanceof Error ? submitFailure.message : "Your request could not be sent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) return <main className="min-h-screen bg-[#fffdf8] px-4 py-20"><LoadingState label="Loading Hopkins Grove information" /></main>;
  if (isError || !page) return <main className="mx-auto grid min-h-screen max-w-3xl content-center gap-4 bg-[#fffdf8] px-4 py-12"><h1 className="font-display text-3xl font-semibold text-[#173f2d]">Hopkins Grove information is temporarily unavailable</h1><ErrorState message={error instanceof Error ? error.message : "Please contact Ceiba Realty & Development directly."} /><a className="text-sm font-semibold text-[#173f2d] underline" href="mailto:properties@ceibabelize.com">Contact the project team</a></main>;

  if (templateId === "wamule-classic") {
    return <HopkinsWamuleClassicPage
      page={page}
      modules={modules}
      selectedMapFeatureRefs={selectedMapFeatureRefs}
      mapFeatureLabels={mapFeatureLabels}
      mapPreferenceError={mapPreferenceError}
      onToggleMapFeature={toggleMapFeature}
      onRemoveMapFeature={(ref) => {
        setSelectedMapFeatureRefs((current) => current.filter((item) => item !== ref));
        setMapPreferenceError(null);
      }}
      onParcelsLoaded={(features) => setMapFeatureLabels(features.flatMap((feature) => feature.map_feature_ref
        ? [{ ref: feature.map_feature_ref, label: feature.demo_label ?? feature.map_feature_ref }]
        : []))}
      hasSupabaseConfig={hasSupabaseConfig}
    />;
  }

  return (
    <main data-site-template={templateId} data-public-tenant="hopkins-grove" className="min-h-screen overflow-x-hidden bg-[#fffdf8] text-[#2d2317]">
      <header className="sticky top-0 z-30 border-b border-[#173f2d]/10 bg-[#fffdf8]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="#home" className="min-w-0 leading-tight" aria-label="Hopkins Grove by Ceiba Realty and Development">
            <span className="block text-[11px] font-bold uppercase tracking-[0.21em] text-[#8a5a35]">Ceiba Realty &amp; Development</span>
            <span className="block truncate font-display text-xl font-semibold text-[#173f2d] sm:text-2xl">{page.project.name}</span>
          </a>
          <nav aria-label="Main navigation" className="flex shrink-0 items-center gap-3 text-sm font-semibold">
            {modules.map ? <a href="#map" className="hidden text-[#52635a] hover:text-[#173f2d] sm:inline">Explore map</a> : null}
            {modules.application ? <Link to="/hopkins/application" className="hidden text-[#52635a] hover:text-[#173f2d] sm:inline">Project application</Link> : null}
            {modules.inquiry ? <a href="#interest" className="inline-flex min-h-10 items-center rounded-full bg-[#173f2d] px-4 text-white hover:bg-[#245a40]">Get in touch</a> : null}
          </nav>
        </div>
      </header>

      <section id="home" className="relative isolate overflow-hidden border-b border-[#173f2d]/10">
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_78%_20%,rgba(194,130,86,0.20),transparent_38%),linear-gradient(115deg,#fffdf8_0%,#f6f4e8_54%,#edf1e9_100%)]" />
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-end lg:py-24">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-[#173f2d]/15 bg-white/70 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.16em] text-[#376448]"><MapPin className="h-3.5 w-3.5" /> Hopkins Village, Belize</p>
            <h1 className="mt-6 max-w-3xl break-words font-display text-4xl font-semibold leading-[1.04] tracking-tight text-[#173f2d] sm:text-6xl">A place to put down roots.</h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#52635a] sm:text-lg">{page.company.description}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              {modules.map ? <a className="inline-flex min-h-12 items-center gap-2 rounded-full bg-[#173f2d] px-6 font-semibold text-white shadow-sm hover:bg-[#245a40]" href="#map">Explore the plan <ArrowDown className="h-4 w-4" /></a> : null}
              {modules.inquiry ? <a className="inline-flex min-h-12 items-center gap-2 rounded-full border border-[#173f2d]/20 bg-white/70 px-6 font-semibold text-[#173f2d] hover:bg-white" href="#interest">Register your interest <ArrowUpRight className="h-4 w-4" /></a> : null}
              {modules.application ? <a className="inline-flex min-h-12 items-center gap-2 rounded-full border border-[#173f2d]/20 bg-white/70 px-6 font-semibold text-[#173f2d] hover:bg-white" href="#application">Start a project application <ArrowUpRight className="h-4 w-4" /></a> : null}
            </div>
            <p className="mt-5 max-w-2xl text-xs leading-5 text-[#68736c]">Map outlines are project references. They do not indicate verified saleable inventory, current availability, or an allocated lot.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:pb-2">
            <article className="rounded-2xl border border-[#173f2d]/10 bg-white/80 p-5 shadow-sm backdrop-blur-sm">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#8a5a35]">The setting</p>
              <h2 className="mt-2 font-display text-xl font-semibold text-[#173f2d]">Hopkins Village</h2>
              <p className="mt-2 text-sm leading-6 text-[#52635a]">{page.company.location}</p>
            </article>
            <article className="rounded-2xl border border-[#173f2d]/10 bg-white/80 p-5 shadow-sm backdrop-blur-sm sm:translate-y-8">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#8a5a35]">Project plan</p>
              <h2 className="mt-2 font-display text-xl font-semibold text-[#173f2d]">See the published map</h2>
              <p className="mt-2 text-sm leading-6 text-[#52635a]">Explore mapped outlines and source notes. Pricing and availability are confirmed by the project team.</p>
            </article>
          </div>
        </div>
      </section>

      {modules.map ? <section id="map" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8a5a35]">Published project map</p>
            <h2 className="mt-2 font-display text-3xl font-semibold text-[#173f2d] sm:text-4xl">Explore Hopkins Grove</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#52635a]">Select an outline to see its published source information. A map feature is not a saleable parcel, and no lot is reserved or assigned through this map.</p>
          </div>
          <a href={MAP_URL} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-[#173f2d]/20 bg-white px-4 text-sm font-semibold text-[#173f2d] hover:bg-[#f3f5ef]">Open standalone map <ArrowUpRight className="h-4 w-4" /></a>
        </div>
        <div className="h-[800px] overflow-hidden rounded-2xl border border-[#173f2d]/15 bg-white shadow-[0_18px_55px_rgba(23,63,45,0.09)] sm:h-[780px] md:h-[760px]">
          <PublicLotMap
            tenantSlug={HOPKINS_SCOPE.tenant}
            projectSlug={HOPKINS_SCOPE.project}
            phaseSlug={HOPKINS_SCOPE.phase}
            showPrices={modules.pricing}
            enableInquiry
            initialView="tier"
            selectedMapFeatureRefs={selectedMapFeatureRefs}
            onToggleMapFeature={toggleMapFeature}
            onParcelsLoaded={(features) => setMapFeatureLabels(features.flatMap((feature) => feature.map_feature_ref
              ? [{ ref: feature.map_feature_ref, label: feature.demo_label ?? feature.map_feature_ref }]
              : []))}
          />
        </div>
        <p className="mt-3 text-xs leading-5 text-[#68736c]">Generated map references, printed plan labels, source-tier matches, and saleable inventory are distinct records. A displayed source match is not an availability statement.</p>
      </section> : null}

      {modules.inquiry ? <section id="interest" className="scroll-mt-24 bg-[#edf1e9] px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="max-w-xl">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8a5a35]">Project information</p>
            <h2 className="mt-2 font-display text-3xl font-semibold text-[#173f2d] sm:text-4xl">Let’s talk about Hopkins Grove.</h2>
            <p className="mt-4 text-sm leading-6 text-[#52635a]">Send a general project inquiry and the Hopkins team can share current information. This preview does not accept a purchase application, confirm pricing or availability, reserve a lot, or allocate a map outline.</p>
            <div className="mt-6 grid gap-2 text-sm text-[#385448]">
              <a className="w-fit font-semibold underline decoration-[#8a5a35]/50 underline-offset-4" href={`mailto:${page.company.email}`}>{page.company.email}</a>
              <a className="w-fit font-semibold underline decoration-[#8a5a35]/50 underline-offset-4" href={`tel:${page.company.phone.replace(/[^+\d]/g, "")}`}>{page.company.phone}</a>
              <a className="w-fit font-semibold underline decoration-[#8a5a35]/50 underline-offset-4" href={page.company.website} target="_blank" rel="noreferrer">Ceiba Realty &amp; Development <ArrowUpRight className="inline h-3.5 w-3.5" /></a>
            </div>
            <div className="mt-8 rounded-xl border border-[#173f2d]/10 bg-white/70 p-4 text-sm leading-6 text-[#52635a]">
              <p className="font-semibold text-[#173f2d]">Important information</p>
              <p className="mt-1">{page.company.publicNotice}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#173f2d]/10 bg-white p-5 shadow-sm sm:p-7">
            {submitted ? (
              <div role="status" className="grid justify-items-start gap-3 py-6">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-[#e6f0e7] text-[#24613e]"><CheckCircle2 className="h-6 w-6" /></span>
                <h3 className="font-display text-2xl font-semibold text-[#173f2d]">Thank you for your interest.</h3>
                <p className="max-w-lg text-sm leading-6 text-[#52635a]">Your project inquiry was sent to Hopkins Grove. It does not create an application, reserve a property, or assign a map outline.</p>
                <Button type="button" variant="outline" onClick={() => { setSubmitted(false); setName(""); setEmail(""); setPhone(""); setMessage(""); setRequestId(fallbackUuid()); }}>Send another inquiry</Button>
              </div>
            ) : (
              <form className="grid gap-4" onSubmit={(event) => void submitInterest(event)}>
                <div>
                  <h3 className="font-display text-2xl font-semibold text-[#173f2d]">Register your interest</h3>
                  <p className="mt-1 text-sm leading-6 text-[#68736c]">General project information only. No lot selection is needed.</p>
                </div>
                {submitError ? <ErrorState message={submitError} /> : null}
                <Field label="Full name"><Input name="name" autoComplete="name" maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
                <Field label="Email address"><Input name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
                <Field label="Phone / WhatsApp (optional)"><Input name="phone" autoComplete="tel" maxLength={40} value={phone} onChange={(event) => setPhone(event.target.value)} /></Field>
                <Field label="What would you like to know? (optional)"><Textarea name="message" maxLength={1000} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} /></Field>
                <p className="text-xs leading-5 text-[#68736c]">Your details will be used by Ceiba Realty &amp; Development to respond to this request.</p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send project inquiry"}<Send className="ml-2 h-4 w-4" /></Button>
                  <Link to={MAP_URL} className="text-sm font-semibold text-[#173f2d] underline underline-offset-4">Explore the map first</Link>
                </div>
              </form>
            )}
          </div>
        </div>
      </section> : null}

      {modules.application ? <HopkinsProjectApplication
        page={page}
        modules={modules}
        isClassicTemplate={false}
        selectedMapFeatureRefs={selectedMapFeatureRefs}
        mapFeatureLabels={mapFeatureLabels}
        mapPreferenceError={mapPreferenceError}
        onToggleMapFeature={toggleMapFeature}
        onParcelsLoaded={(features) => setMapFeatureLabels(features.flatMap((feature) => feature.map_feature_ref
          ? [{ ref: feature.map_feature_ref, label: feature.demo_label ?? feature.map_feature_ref }]
          : []))}
        onRemoveMapFeature={(ref) => {
          setSelectedMapFeatureRefs((current) => current.filter((item) => item !== ref));
          setMapPreferenceError(null);
        }}
      /> : null}

      <footer className="border-t border-[#173f2d]/10 bg-[#fffdf8] px-4 py-7 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 text-xs leading-5 text-[#68736c] sm:flex-row sm:items-center sm:justify-between">
          <p><span className="font-semibold text-[#173f2d]">{page.project.name}</span> · {page.company.name}</p>
          <p>Public project preview · <Link to={MAP_URL} className="font-semibold text-[#173f2d] underline underline-offset-2">Standalone map</Link></p>
        </div>
      </footer>
    </main>
  );
}

function HopkinsWamuleClassicPage({
  page,
  modules,
  selectedMapFeatureRefs,
  mapFeatureLabels,
  mapPreferenceError,
  onToggleMapFeature,
  onRemoveMapFeature,
  onParcelsLoaded,
  hasSupabaseConfig,
}: {
  page: PublicProjectPage;
  modules: Record<PublicSiteModuleId, boolean>;
  selectedMapFeatureRefs: string[];
  mapFeatureLabels: Array<{ ref: string; label: string }>;
  mapPreferenceError: string | null;
  onToggleMapFeature: (parcel: PublicLotParcel) => void;
  onRemoveMapFeature: (ref: string) => void;
  onParcelsLoaded: (features: PublicLotParcel[]) => void;
  hasSupabaseConfig: boolean;
}) {
  const outlineCount = mapFeatureLabels.length;
  return (
    <main data-site-template="wamule-classic" data-public-tenant="hopkins-grove" className="min-h-screen bg-background">
      <WamuleClassicHeader
        companyName={page.company.name}
        logoUrl="/favicon/hopkins-grove.svg"
        homeHref="/hopkins"
        mapHref="#lots"
        applyHref="/hopkins/application"
        applyLabel="Apply"
        showApply={modules.application}
        mapLabel="Project map"
      />

      <WamuleClassicHero
        badge={<Badge tone="green">Hopkins Grove · public project</Badge>}
        title={page.project.name}
        description={page.company.description}
        facts={<>
          <WamuleClassicInfoTile label="Location" value={page.company.location || "Hopkins Village, Belize"} />
          <WamuleClassicInfoTile label="Project phase" value={page.phase.name} />
          <WamuleClassicInfoTile label="Map outlines" value={outlineCount ? outlineCount + " outlines" : "Loading map"} />
        </>}
        actions={<>
          {modules.map ? <a className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]" href="#lots">
            Explore the project map <ArrowDown className="h-4 w-4" />
          </a> : null}
          {modules.application ? <a className="focus-ring inline-flex h-11 items-center gap-2 rounded-md border border-primary/20 bg-card px-5 text-sm font-semibold text-primary transition hover:bg-primary-soft" href="/hopkins/application">
            Start an application <ArrowUpRight className="h-4 w-4" />
          </a> : null}
        </>}
        sideContent={<WamuleClassicPanel
          title="Project overview"
          description="Published information for Hopkins Grove"
        >
          <div className="grid gap-3 text-sm leading-6 text-foreground">
            <p>{page.company.location}</p>
            <p>Explore source-referenced outlines on the project map and ask Ceiba Realty &amp; Development for current information.</p>
            <p className="rounded-md border border-primary/10 bg-primary-soft/35 p-3 text-xs leading-5 text-muted-foreground">
              Map outlines are project references. Hopkins currently has no parcel inventory, and a map selection does not assign or reserve a lot.
            </p>
          </div>
        </WamuleClassicPanel>}
      />

      {modules.map ? <section id="lots" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-semibold text-primary">Hopkins Grove project map</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              Select an outline for published source information. Outline references remain separate from saleable parcel inventory.
            </p>
          </div>
          <a className="text-sm font-semibold text-primary underline underline-offset-4" href={MAP_URL}>Open standalone map</a>
        </div>
        <div className="h-[560px] min-w-0 overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-card)] sm:h-[640px] lg:h-[720px]">
          <PublicLotMap
            tenantSlug={HOPKINS_SCOPE.tenant}
            projectSlug={HOPKINS_SCOPE.project}
            phaseSlug={HOPKINS_SCOPE.phase}
            showPrices={modules.pricing}
            enableInquiry
            initialView="tier"
            selectedMapFeatureRefs={selectedMapFeatureRefs}
            onToggleMapFeature={onToggleMapFeature}
            onParcelsLoaded={onParcelsLoaded}
          />
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Source pricing is informational. Selection records an optional map-outline preference only.</p>
      </section> : null}

      <WamuleClassicNotice
        title="Hopkins project notice"
        notice={page.company.publicNotice}
        companyName={page.company.name}
        location={page.company.location}
      />

      {modules.inquiry ? <section id="interest" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-6">
        <PublicInquiryPanel
          companyName={page.company.name}
          tenantSlug={HOPKINS_SCOPE.tenant}
          projectSlug={HOPKINS_SCOPE.project}
          phaseSlug={HOPKINS_SCOPE.phase}
          parcels={[]}
          showPrices={false}
          hasSupabaseConfig={hasSupabaseConfig}
          interestOptions={["General project interest", "Map outline question", "Site visit", "Buying process"]}
          introPrompt="Planning a project?"
          introDescription={"Ask Ceiba Realty & Development about " + page.project.name + ", the application process, a site visit, or information shown on the public map."}
          introNotice="This inquiry is for information only. It does not allocate a map outline, create parcel inventory, or reserve a lot."
          confirmationNote="Your request was saved for Hopkins. It does not assign a map outline or create parcel inventory."
          footerNote="Map outlines are references only; an inquiry does not allocate or reserve one."
          mapHref="#lots"
        />
      </section> : null}

      {modules.application ? <HopkinsProjectApplication
        page={page}
        modules={modules}
        isClassicTemplate
        selectedMapFeatureRefs={selectedMapFeatureRefs}
        mapFeatureLabels={mapFeatureLabels}
        mapPreferenceError={mapPreferenceError}
        onToggleMapFeature={onToggleMapFeature}
        onRemoveMapFeature={onRemoveMapFeature}
        onParcelsLoaded={onParcelsLoaded}
      /> : null}

      <footer className="mx-auto flex max-w-6xl flex-col gap-1 border-t border-border px-4 py-5 text-xs leading-5 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p><span className="font-semibold text-primary">{page.project.name}</span> · {page.company.name}</p>
        <p>Public project preview · <Link to={MAP_URL} className="font-semibold text-primary underline underline-offset-2">Standalone map</Link></p>
      </footer>
    </main>
  );
}

function HopkinsProjectApplication({
  page,
  modules,
  isClassicTemplate,
  selectedMapFeatureRefs,
  mapFeatureLabels,
  mapPreferenceError,
  onToggleMapFeature,
  onParcelsLoaded,
  onRemoveMapFeature,
}: {
  page: PublicProjectPage;
  modules: Record<PublicSiteModuleId, boolean>;
  isClassicTemplate: boolean;
  selectedMapFeatureRefs: string[];
  mapFeatureLabels: Array<{ ref: string; label: string }>;
  mapPreferenceError: string | null;
  onToggleMapFeature: (parcel: PublicLotParcel) => void;
  onParcelsLoaded: (features: PublicLotParcel[]) => void;
  onRemoveMapFeature: (ref: string) => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [nationality, setNationality] = useState("");
  const [occupation, setOccupation] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [intendedUse, setIntendedUse] = useState("");
  const [otherUse, setOtherUse] = useState("");
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submissionReference, setSubmissionReference] = useState(fallbackUuid);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ message: string; id?: number } | null>(null);

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const data = await submitPublicFunction<{ ok?: boolean; message?: string; application_id?: number }>("submit-hopkins-project-application", buildHopkinsProjectApplicationPayload({
          submission_reference: submissionReference,
          applicant_full_name: name,
          applicant_address: address,
          nationality,
          occupation,
          phone,
          email,
          intended_use: intendedUse,
          intended_use_other: otherUse,
          preferred_map_feature_refs: selectedMapFeatureRefs,
          notes,
          legal_notice_acknowledged: acknowledged,
          applicant_acknowledgement_signature: signature,
        }));
      if (data?.ok !== true) throw new Error("Your project application could not be confirmed. Please retry.");
      setReceipt({ message: String(data.message || page.applicationSettings.confirmationMessage), id: Number(data.application_id) || undefined });
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : "Your application could not be sent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetApplication() {
    setName(""); setAddress(""); setNationality(""); setOccupation(""); setPhone(""); setEmail("");
    setIntendedUse(""); setOtherUse(""); setNotes(""); setSignature(""); setAcknowledged(false);
    setSubmissionReference(fallbackUuid()); setReceipt(null); setSubmitError(null);
    selectedMapFeatureRefs.forEach(onRemoveMapFeature);
  }

  return (
    <section id="application" className={isClassicTemplate ? "scroll-mt-20 mx-auto max-w-6xl px-4 py-10 lg:py-12" : "scroll-mt-20 bg-[#fffdf8] px-4 py-12 sm:px-6 sm:py-16"}>
      {modules.map ? <div id="application-map" className="mb-8 scroll-mt-20">
        <WamuleClassicPanel
          title="Choose map-outline preferences"
          description="Select optional map references for the Hopkins team to review."
        >
          <div className="h-[560px] min-w-0 overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-card)] sm:h-[640px] lg:h-[720px]">
            <PublicLotMap
              tenantSlug={HOPKINS_SCOPE.tenant}
              projectSlug={HOPKINS_SCOPE.project}
              phaseSlug={HOPKINS_SCOPE.phase}
              showPrices={modules.pricing}
              enableInquiry
              initialView="tier"
              selectedMapFeatureRefs={selectedMapFeatureRefs}
              onToggleMapFeature={onToggleMapFeature}
              onParcelsLoaded={onParcelsLoaded}
            />
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            These are map-outline references, not parcel IDs. Preferences can be removed below and do not allocate a lot.
          </p>
        </WamuleClassicPanel>
      </div> : null}
      <div className={isClassicTemplate ? "grid gap-8 lg:grid-cols-[0.72fr_1.28fr]" : "mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.72fr_1.28fr]"}>
        <div className="max-w-xl">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8a5a35]">Hopkins Grove · staff review</p>
          <h2 className="mt-2 font-display text-3xl font-semibold text-[#173f2d] sm:text-4xl">Project application</h2>
          <p className="mt-4 text-sm leading-6 text-[#52635a]">Share your project interest and contact details for the Hopkins team to review. This application does not select or allocate a parcel.</p>
          <div className="mt-6 rounded-xl border border-[#173f2d]/10 bg-[#edf1e9] p-4 text-sm leading-6 text-[#52635a]">
            <p className="font-semibold text-[#173f2d]">Hopkins project notice</p>
            <p className="mt-2">{page.applicationSettings.publicNotice}</p>
            <p className="mt-3 border-t border-[#173f2d]/10 pt-3">{page.applicationSettings.acknowledgmentText}</p>
          </div>
        </div>

        <div className={isClassicTemplate ? "min-w-0 rounded-lg border bg-card p-5 shadow-[var(--shadow-card)] sm:p-7" : "rounded-2xl border border-[#173f2d]/10 bg-white p-5 shadow-sm sm:p-7"}>
          {receipt ? (
            <div role="status" className="grid justify-items-start gap-3 py-6">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-[#e6f0e7] text-[#24613e]"><CheckCircle2 className="h-6 w-6" /></span>
              <h3 className="font-display text-2xl font-semibold text-[#173f2d]">Application received for review</h3>
              <p className="max-w-lg text-sm leading-6 text-[#52635a]">{receipt.message} No parcel or map outline has been assigned.</p>
              {receipt.id ? <p className="text-xs text-[#68736c]">Application reference {receipt.id}</p> : null}
              <Button type="button" variant="outline" onClick={resetApplication}>Start another application</Button>
            </div>
          ) : (
            <form className="grid gap-5" onSubmit={(event) => void submitApplication(event)}>
              <div>
                <h3 className="font-display text-2xl font-semibold text-[#173f2d]">Applicant information</h3>
                <p className="mt-1 text-sm leading-6 text-[#68736c]">No lot selection, payment choice, or purchase availability is required.</p>
              </div>
              {!page.applicationSettings.applicationsOpen ? <p role="status" className="rounded-lg bg-[#f5f0e9] p-3 text-sm text-[#52635a]">Hopkins project applications are currently closed.</p> : null}
              {submitError ? <ErrorState message={submitError} /> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full legal name"><Input name="applicant_full_name" autoComplete="name" maxLength={160} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
                <Field label="Nationality"><Input name="nationality" autoComplete="country-name" maxLength={100} required value={nationality} onChange={(event) => setNationality(event.target.value)} /></Field>
                <Field label="Occupation"><Input name="occupation" autoComplete="organization-title" maxLength={160} required value={occupation} onChange={(event) => setOccupation(event.target.value)} /></Field>
                <Field label="Phone / WhatsApp"><Input name="phone" type="tel" autoComplete="tel" maxLength={40} required value={phone} onChange={(event) => setPhone(event.target.value)} /></Field>
                <Field label="Email address"><Input name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
                <Field label="Intended project use"><Select name="intended_use" required value={intendedUse} onChange={(event) => setIntendedUse(event.target.value)}><option value="">Choose a use</option>{page.applicationSettings.intendedUses.map((use) => <option key={use} value={use}>{use}</option>)}</Select></Field>
                <div className="sm:col-span-2"><Field label="Mailing address"><Textarea name="applicant_address" autoComplete="street-address" maxLength={500} rows={2} required value={address} onChange={(event) => setAddress(event.target.value)} /></Field></div>
                {intendedUse === "Other" ? <div className="sm:col-span-2"><Field label="Describe your intended use"><Input name="intended_use_other" maxLength={500} required value={otherUse} onChange={(event) => setOtherUse(event.target.value)} /></Field></div> : null}
              </div>

              <fieldset className="grid gap-3 rounded-xl border border-[#173f2d]/10 bg-[#fffdf8] p-4">
                <legend className="px-1 text-sm font-semibold text-[#173f2d]">Optional map-outline interests</legend>
                <p className="text-sm leading-5 text-[#68736c]">Select outlines on the map above, up to {page.applicationSettings.maxMapPreferences}. Generated map references are saved as preferences only; they are separate from saleable parcels.</p>
                {selectedMapFeatureRefs.length === 0 ? <p className="text-sm text-[#52635a]">No outline preference selected. You can still submit a general Hopkins project application.</p> : (
                  <ul className="grid gap-2 sm:grid-cols-2">{selectedMapFeatureRefs.map((ref) => {
                    const label = mapFeatureLabels.find((feature) => feature.ref === ref)?.label ?? `Map outline ${ref.slice(0, 8)}`;
                    return <li key={ref} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-[#173f2d]/10 bg-white px-3 py-2 text-sm text-[#385448]">
                      <span className="min-w-0 truncate">{label}</span><button type="button" className="min-h-9 shrink-0 px-2 font-semibold text-[#8a5a35] underline underline-offset-2" onClick={() => onRemoveMapFeature(ref)}>Remove</button>
                    </li>;
                  })}</ul>
                )}
                {mapPreferenceError ? <p role="alert" className="text-sm text-red-700">{mapPreferenceError}</p> : null}
              </fieldset>

              <Field label="Anything else the Hopkins team should know? (optional)"><Textarea name="notes" maxLength={2000} rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
              <label className="flex items-start gap-3 rounded-lg border border-[#173f2d]/10 bg-[#edf1e9]/60 p-3 text-sm leading-5 text-[#52635a]">
                <input className="mt-1 h-4 w-4 shrink-0 accent-[#173f2d]" type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>I have read and acknowledge the Hopkins project notice and application terms shown above.</span>
              </label>
              <Field label="Type your full name to sign"><Input name="applicant_acknowledgement_signature" autoComplete="name" maxLength={160} required value={signature} onChange={(event) => setSignature(event.target.value)} /></Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={submitting || !page.applicationSettings.applicationsOpen}>{submitting ? "Submitting…" : "Submit project application"}<Send className="ml-2 h-4 w-4" /></Button>
                <span className="text-xs leading-5 text-[#68736c]">Stored for Hopkins staff review. No messages are sent by this form.</span>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
