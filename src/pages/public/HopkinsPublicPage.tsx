import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUpRight, CheckCircle2, MapPin, Send } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { PublicLotMap } from "../../components/public/PublicLotMap";
import { Button } from "../../components/ui/Button";
import { Field, Input, Textarea } from "../../components/ui/Field";
import { ErrorState, LoadingState } from "../../components/ui/State";
import { buildInquiryPayload } from "../../../supabase/functions/_shared/inquiry-contract";
import type { PublicExperienceScope, PublicSiteModuleId, PublicSiteTemplateId } from "../../lib/publicExperience.mjs";
import type { PublicPhaseOption } from "../../lib/publicSiteExperience";
import { applyPublicPageMetadata, publicCanonicalUrl } from "../../lib/publicPageMetadata";
import { hasSupabaseConfig } from "../../lib/supabase";
import { submitPublicFunction } from "../../lib/publicSubmission";

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

async function loadPublicProjectPage(hostname: string, scope: PublicExperienceScope): Promise<PublicProjectPage> {
  const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!baseUrl || !anonKey) throw new Error("The public project page is not configured.");

  const params = new URLSearchParams({ tenant: scope.tenantSlug, project: scope.projectSlug, phase: scope.phaseSlug });
  if (hostname) params.set("host", hostname);
  const response = await fetch(`${baseUrl}/functions/v1/get-public-project-page?${params}`, {
    method: "GET",
    headers: { apikey: anonKey, Accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as PublicProjectPage & { error?: string };
  if (!response.ok || body.tenant?.slug !== scope.tenantSlug
    || body.project?.slug !== scope.projectSlug || body.phase?.slug !== scope.phaseSlug
    || !body.company?.name || !body.company?.email || !body.company?.publicNotice
    || !body.applicationSettings?.noticeVersion || !body.applicationSettings?.publicNotice
    || !body.applicationSettings?.acknowledgmentText || !Array.isArray(body.applicationSettings?.intendedUses)) {
    throw new Error(body.error || "Hopkins public information could not be verified.");
  }
  return body;
}

export function HopkinsPublicPage({
  hostname,
  scope,
  phases,
  templateId: selectedTemplate,
  enabledModules: selectedModules,
  application,
  applicationHref,
  applyWithOutline,
}: {
  hostname: string;
  scope: PublicExperienceScope;
  phases: PublicPhaseOption[];
  templateId?: PublicSiteTemplateId;
  enabledModules?: Record<PublicSiteModuleId, boolean>;
  application: ReactNode;
  applicationHref: string;
  applyWithOutline?: (ref: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const templateId = selectedTemplate ?? "hopkins-project";
  const modules = selectedModules ?? { map: true, inquiry: true, application: true, pricing: true };
  const { data: page, isLoading, isError, error } = useQuery({
    queryKey: ["public-project-page", hostname, scope.tenantSlug, scope.projectSlug, scope.phaseSlug],
    queryFn: () => loadPublicProjectPage(hostname, scope),
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
  const mapUrl = hostname
    ? `/embed/${encodeURIComponent(scope.tenantSlug)}/${encodeURIComponent(scope.projectSlug)}?phase=${encodeURIComponent(scope.phaseSlug)}&view=tier`
    : `/p/${encodeURIComponent(scope.tenantSlug)}/${encodeURIComponent(scope.projectSlug)}/map?phase=${encodeURIComponent(scope.phaseSlug)}&view=tier`;

  function changePhase(phaseSlug: string) {
    const params = new URLSearchParams(location.search);
    params.set("phase", phaseSlug);
    navigate(`${location.pathname}?${params.toString()}`);
  }

  useEffect(() => {
    const restorePublicMetadata = applyPublicPageMetadata({
      title: `${page?.project?.name ?? "Project"} | ${page?.company?.name ?? "Development"}`,
      description: `Explore the ${page?.project?.name ?? "project"} map and contact the project team for current information.`,
      url: publicCanonicalUrl(window.location.href),
    });
    const applicationMeta = document.querySelector<HTMLMetaElement>('meta[name="application-name"]');
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const priorApplicationName = applicationMeta?.content;
    const priorTheme = themeMeta?.content;
    const iconLinks = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
    const priorIcons = iconLinks.map((link) => link.href);
    if (applicationMeta) applicationMeta.content = page?.project?.name ?? "Project";
    if (themeMeta) themeMeta.content = "#173f2d";
    iconLinks.forEach((link) => { link.href = "/favicon/hopkins-grove.svg"; });
    return () => {
      restorePublicMetadata();
      if (applicationMeta && priorApplicationName !== undefined) applicationMeta.content = priorApplicationName;
      if (themeMeta && priorTheme !== undefined) themeMeta.content = priorTheme;
      iconLinks.forEach((link, index) => { link.href = priorIcons[index] ?? link.href; });
    };
  }, [location.pathname, location.search, page]);

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
          tenant: scope.tenantSlug,
          project: scope.projectSlug,
          phase: scope.phaseSlug,
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

  return (
    <main data-site-template={templateId} className="min-h-screen overflow-x-hidden bg-[#fffdf8] text-[#2d2317]">
      <header className="sticky top-0 z-30 border-b border-[#173f2d]/10 bg-[#fffdf8]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="#home" className="min-w-0 leading-tight" aria-label="Hopkins Grove by Ceiba Realty and Development">
            <span className="block text-[11px] font-bold uppercase tracking-[0.21em] text-[#8a5a35]">Ceiba Realty &amp; Development</span>
            <span className="block truncate font-display text-xl font-semibold text-[#173f2d] sm:text-2xl">{page.project.name}</span>
          </a>
          <nav aria-label="Main navigation" className="flex shrink-0 items-center gap-3 text-sm font-semibold">
            {modules.map ? <a href="#map" className="hidden text-[#52635a] hover:text-[#173f2d] sm:inline">Explore map</a> : null}
            {modules.application ? <Link to={applicationHref} className="hidden text-[#52635a] hover:text-[#173f2d] sm:inline">Project application</Link> : null}
            {modules.inquiry ? <a href="#interest" className="inline-flex min-h-10 items-center rounded-full bg-[#173f2d] px-4 text-white hover:bg-[#245a40]">Get in touch</a> : null}
            {phases.length > 1 ? <select aria-label="Project phase" className="h-10 rounded-md border border-[#173f2d]/20 bg-white px-2" value={scope.phaseSlug} onChange={(event) => changePhase(event.target.value)}>
              {phases.map((phase) => <option key={phase.slug} value={phase.slug}>{phase.name}</option>)}
            </select> : null}
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
              {modules.application ? <Link className="inline-flex min-h-12 items-center gap-2 rounded-full border border-[#173f2d]/20 bg-white/70 px-6 font-semibold text-[#173f2d] hover:bg-white" to={applicationHref}>Start a project application <ArrowUpRight className="h-4 w-4" /></Link> : null}
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
          <a href={mapUrl} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-[#173f2d]/20 bg-white px-4 text-sm font-semibold text-[#173f2d] hover:bg-[#f3f5ef]">Open standalone map <ArrowUpRight className="h-4 w-4" /></a>
        </div>
        <div className="h-[800px] overflow-hidden rounded-2xl border border-[#173f2d]/15 bg-white shadow-[0_18px_55px_rgba(23,63,45,0.09)] sm:h-[780px] md:h-[760px]">
          <PublicLotMap
            key={`${hostname}/${scope.tenantSlug}/${scope.projectSlug}/${scope.phaseSlug}`}
            hostname={hostname}
            tenantSlug={scope.tenantSlug}
            projectSlug={scope.projectSlug}
            phaseSlug={scope.phaseSlug}
            showPrices={modules.pricing}
            enableInquiry
            initialView="tier"
            onApplyWithPlot={applyWithOutline ? (parcel) => {
              if (parcel.map_feature_ref) applyWithOutline(parcel.map_feature_ref);
            } : undefined}
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
                  <Link to={mapUrl} className="text-sm font-semibold text-[#173f2d] underline underline-offset-4">Explore the map first</Link>
                </div>
              </form>
            )}
          </div>
        </div>
      </section> : null}

      {application}

      <footer className="border-t border-[#173f2d]/10 bg-[#fffdf8] px-4 py-7 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 text-xs leading-5 text-[#68736c] sm:flex-row sm:items-center sm:justify-between">
          <p><span className="font-semibold text-[#173f2d]">{page.project.name}</span> · {page.company.name}</p>
          <p>Public project preview · <Link to={mapUrl} className="font-semibold text-[#173f2d] underline underline-offset-2">Standalone map</Link></p>
        </div>
      </footer>
    </main>
  );
}
