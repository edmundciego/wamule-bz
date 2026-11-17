import { ArrowRight, HelpCircle, Send, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { usePublicApplicationPlots, type PublicParcelOption } from "../lib/publicApplicationPlots";
import { submitPublicFunction } from "../lib/publicSubmission";
import type { PublicExperienceScope } from "../lib/publicExperience.mjs";
import type { PublicPhaseOption, PublicSiteData } from "../lib/publicSiteExperience";
import { buildInquiryPayload } from "../../supabase/functions/_shared/inquiry-contract";
import { hasSupabaseConfig } from "../lib/supabase";
import { cn, money } from "../lib/utils";

const inquiryInterests = [
  "Available lots",
  "Lot pricing",
  "Payment options",
  "Site visit",
  "Buying process",
  "A specific lot",
] as const;

type InquiryInterest = (typeof inquiryInterests)[number];
const specificLotInterest: InquiryInterest = "A specific lot";
function fallbackUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-${Date.now().toString(16)}`.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function ApplicationPage({
  hostname,
  data,
  phases,
  application,
  applicationHref,
}: {
  hostname: string;
  data: PublicSiteData;
  phases: PublicPhaseOption[];
  application: ReactNode;
  applicationHref: string;
}) {
  const { scope, company, publicApplication: applicationSettings, siteExperience } = data;
  const { templateId, enabledModules: modules } = siteExperience;
  const location = useLocation();
  const navigate = useNavigate();
  const phaseName = phases.find((phase) => phase.slug === scope.phaseSlug)?.name ?? scope.phaseSlug;

  function changePhase(phaseSlug: string) {
    const params = new URLSearchParams(location.search);
    params.set("phase", phaseSlug);
    navigate(`${location.pathname}?${params.toString()}`);
  }

  const { data: lotData, isLoading } = usePublicApplicationPlots(hostname, scope, Boolean(hostname));
  const parcels = lotData?.parcels ?? [];
  const availableLots = parcels.length;
  const visiblePrices = parcels.map((parcel) => parcel.base_price).filter((price) => Number.isFinite(price) && price > 0);
  const startingPrice = visiblePrices.length ? Math.min(...visiblePrices) : null;

  return (
    <main data-site-template={templateId} data-site-map={modules.map} className="min-h-screen bg-background">
      <header className="border-b border-primary/10 bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <a href="/" className="flex items-center gap-3">
            <img
              src={company.logo_url || "/favicon/android-chrome-192x192.png"}
              alt={company.company_name}
              className="h-12 w-12 rounded-md border border-secondary/30 bg-background object-cover shadow-sm"
            />
            <div>
              <p className="font-display text-xl font-semibold leading-tight text-primary">{company.company_name.replace(/\s+Development$/i, "")}</p>
              <p className="text-xs font-semibold uppercase tracking-[0.26em] text-secondary">Development</p>
            </div>
          </a>
          <nav className="flex items-center gap-3 text-sm">
            <a className="hidden text-slate hover:text-primary sm:inline" href="#notice">
              Notice
            </a>
            <a className="hidden text-slate hover:text-primary sm:inline" href="#lots">
              Lots
            </a>
            {modules.application ? <Link
              className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]"
              to={applicationHref}
            >
              Apply <ArrowRight className="h-4 w-4" />
            </Link> : null}
            {phases.length > 1 ? <select
              aria-label="Project phase"
              className="h-10 rounded-md border border-primary/20 bg-background px-2 text-sm"
              value={scope.phaseSlug}
              onChange={(event) => changePhase(event.target.value)}
            >{phases.map((phase) => <option key={phase.slug} value={phase.slug}>{phase.name}</option>)}</select> : null}
          </nav>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-14">
        <div className="min-w-0">
          <Badge tone={applicationSettings.applications_open ? "green" : "amber"}>
            {phaseName} applications {applicationSettings.applications_open ? "open" : "closed"}
          </Badge>
          <h1 className="mt-5 max-w-3xl break-words font-display text-4xl font-semibold tracking-normal text-primary sm:text-5xl">
            {company.company_name} Land Application
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
            {company.short_description || `Apply to be considered for property within ${company.company_name}.`}
          </p>
          <div className="wave-rule mt-6 h-3 w-56" />
          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <InfoTile label="Starting price" value={applicationSettings.show_lot_prices_publicly && modules.pricing && startingPrice !== null ? money(startingPrice) : "Contact office"} />
            <InfoTile label="Lot sizes" value={parcels.find((parcel) => parcel.dimensions)?.dimensions || "See available lot details"} />
            <InfoTile label={phaseName} value={applicationSettings.show_available_lot_count_publicly ? `${availableLots} available` : "Availability by review"} />
          </div>
          {modules.application ? <div className="mt-7 flex flex-wrap gap-3">
            <Link className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]" to={applicationHref}>
              Start application <ArrowRight className="h-4 w-4" />
            </Link>
          </div> : null}
        </div>

        <div id="lots" className="min-w-0 overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-card)]">
          <div className="brand-pattern h-4 border-b" />
          <div className="p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="font-display text-xl font-semibold text-primary">Available Lot Preferences</p>
                <p className="text-sm text-muted-foreground">Select preferred lots in the application.</p>
              </div>
              {applicationSettings.show_available_lot_count_publicly ? <Badge tone="green">{availableLots} available</Badge> : null}
            </div>
            {isLoading ? (
              <LoadingState label="Loading lot availability" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {parcels?.slice(0, 4).map((parcel) => (
                  <div key={parcel.public_ref} className="rounded-lg border border-success/20 bg-success/10 p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <strong className="text-primary">Lot {parcel.lot_number}</strong>
                      <span className="rounded-full bg-success/10 px-2 py-1 text-xs font-semibold text-success">{parcel.status}</span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{parcel.dimensions}</p>
                    {applicationSettings.show_lot_prices_publicly && modules.pricing ? <span className="mt-2 block font-semibold text-success">{money(parcel.base_price)}</span> : null}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              View the complete available lot list when choosing your preferred lot. Preference selections do not reserve land.
            </p>
          </div>
        </div>
      </section>

      {modules.inquiry ? <section className="mx-auto max-w-6xl px-4 pb-5" id="request-info">
        <PublicInquiryPanel
          companyName={company.company_name}
          hostname={hostname}
          scope={scope}
          parcels={parcels}
          showPrices={applicationSettings.show_lot_prices_publicly && modules.pricing}
          hasSupabaseConfig={hasSupabaseConfig}
        />
      </section> : null}

      {!application ? <section className="mx-auto max-w-6xl px-4 pb-4" id="notice">
        <div className="grid gap-4 rounded-xl border border-secondary/20 bg-card p-5 shadow-sm shadow-secondary/5 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
          <div className="flex items-start gap-3 lg:block">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-secondary-soft">
              <ShieldCheck className="h-5 w-5 text-secondary" />
            </div>
            <div className="min-w-0 lg:mt-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Before you apply</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-primary">Important Notice</h2>
            </div>
          </div>
          <div className="grid gap-3">
            <p className="max-w-3xl text-sm leading-6 text-foreground">{applicationSettings.public_notice_text}</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs font-medium text-muted-foreground">
              <span>Owner/Developer: {company.company_name}</span>
              {company.location_address ? <span>Location: {company.location_address}</span> : null}
            </div>
          </div>
        </div>
      </section> : null}

      {application}
    </main>
  );
}

function PublicInquiryPanel({
  companyName,
  hostname,
  scope,
  parcels,
  showPrices,
  hasSupabaseConfig,
}: {
  companyName: string;
  hostname: string;
  scope: PublicExperienceScope;
  parcels: PublicParcelOption[];
  showPrices: boolean;
  hasSupabaseConfig: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [interests, setInterests] = useState<InquiryInterest[]>([]);
  const [specificLotRef, setSpecificLotRef] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [emailSent, setEmailSent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Idempotency key, stable for this form instance (see PublicInquiryModal).
  const [clientReferenceId] = useState(() => fallbackUuid());
  const specificLotSelected = interests.includes(specificLotInterest);

  function toggleInterest(interest: InquiryInterest) {
    setInterests((current) => {
      const next = current.includes(interest) ? current.filter((item) => item !== interest) : [...current, interest];
      if (interest === specificLotInterest && current.includes(interest)) setSpecificLotRef("");
      return next;
    });
  }

  async function submitInquiry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim()) {
      setError("Enter your name and email so the team can follow up.");
      return;
    }
    if (specificLotSelected && !specificLotRef) {
      setError("Choose the specific lot you would like information about.");
      return;
    }
    if (!hasSupabaseConfig) {
      setError("Public inquiry submission is not configured in this environment.");
      return;
    }
    if (!scope.tenantSlug || !scope.projectSlug || !scope.phaseSlug || !hostname) {
      setError("This application page is not configured. Please contact the development team.");
      return;
    }

    setSubmitting(true);
    try {
      const data = await submitPublicFunction<{ emailSent?: boolean }>("submit-public-inquiry", buildInquiryPayload({
        name,
        email,
        phone,
        interests,
        specificLotRef: specificLotSelected && specificLotRef ? specificLotRef : null,
        message,
        pageUrl: window.location.href,
        tenant: scope.tenantSlug,
        project: scope.projectSlug,
        phase: scope.phaseSlug,
        clientReferenceId,
      }));
      setSubmitted(true);
      setEmailSent(Boolean(data?.emailSent));
      setName("");
      setEmail("");
      setPhone("");
      setInterests([]);
      setSpecificLotRef("");
      setMessage("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "We could not submit your request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="overflow-hidden rounded-2xl border border-primary/15 bg-card shadow-[0_18px_45px_rgba(45,35,23,0.10)]">
        <div className="brand-pattern h-3 border-b" />
        <div className="grid gap-5 p-5 md:grid-cols-[0.9fr_1.1fr] md:items-center lg:p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Project information</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-primary">Thanks — we received your request.</h2>
          </div>
          <div className="rounded-xl border border-success/20 bg-success/10 p-4 text-sm leading-6 text-foreground">
            <p>Our team will review your questions and follow up using the contact information you provided.</p>
            <p className="mt-2 text-muted-foreground">
              {emailSent
                ? "A confirmation email was sent. Your request does not reserve a lot or guarantee approval."
                : "Your request was saved. It does not reserve a lot or guarantee approval."}
            </p>
            <a className="mt-4 inline-flex font-semibold text-primary hover:text-primary-hover" href="#lots">
              Review live project and lot information
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-primary/15 bg-card shadow-[0_18px_45px_rgba(45,35,23,0.10)]">
      <div className="brand-pattern h-3 border-b" />
      <div className="grid gap-6 p-5 lg:grid-cols-[0.8fr_1.2fr] lg:p-6">
        <div className="min-w-0">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-secondary/25 bg-[#fff8e6] text-secondary">
            <HelpCircle className="h-5 w-5" />
          </div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-secondary">Not ready to apply yet?</p>
          <h2 className="mt-2 break-words font-display text-3xl font-semibold text-primary">Request project information</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Have questions about available lots, pricing, payment options, site visits, or the buying process? Tell us what you're interested in and the {companyName} team can follow up.
          </p>
          <div className="mt-5 rounded-xl border border-primary/10 bg-primary-soft/45 p-4 text-sm leading-6 text-primary">
            This is an information request only. It does not submit an application, reserve a lot, or guarantee approval.
          </div>
        </div>

        <form className="grid gap-4" onSubmit={submitInquiry}>
          {error ? <ErrorState message={error} /> : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} required />
            </Field>
            <Field label="Email">
              <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" maxLength={254} required />
            </Field>
            <div className="md:col-span-2">
              <Field label="Phone / WhatsApp (optional)">
                <Input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" maxLength={40} />
              </Field>
            </div>
          </div>

          <div className="grid gap-2">
            <p className="text-sm font-semibold text-primary">What would you like information about?</p>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {inquiryInterests.map((interest) => {
                const selected = interests.includes(interest);
                return (
                  <button
                    key={interest}
                    type="button"
                    className={cn(
                      "min-h-12 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition",
                      selected ? "border-primary bg-primary-soft text-primary ring-1 ring-primary" : "border-border bg-white text-foreground hover:border-primary/35 hover:bg-primary-soft/25",
                    )}
                    onClick={() => toggleInterest(interest)}
                  >
                    {interest}
                  </button>
                );
              })}
            </div>
          </div>

          {specificLotSelected ? (
            <Field label="Specific lot">
              <Select value={specificLotRef} onChange={(event) => setSpecificLotRef(event.target.value)}>
                <option value="">Select a lot</option>
                {parcels.map((parcel) => (
                  <option key={parcel.public_ref} value={parcel.public_ref}>
                    Lot {parcel.lot_number} {parcel.dimensions ? `- ${parcel.dimensions}` : ""} {showPrices ? `- ${money(parcel.base_price)}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field label="Anything else you'd like us to know?">
            <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} />
          </Field>

          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-muted-foreground">
              Lot availability is not guaranteed or reserved by an inquiry.
            </p>
            <Button type="submit" disabled={submitting}>
              <Send className="h-4 w-4" />
              {submitting ? "Sending request..." : "Request Project Information"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-secondary">{label}</p>
      <p className="mt-1 font-display text-xl font-semibold text-primary">{value}</p>
    </div>
  );
}
