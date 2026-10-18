import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, HelpCircle, MapPin, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useLocation } from "react-router-dom";
import type { z } from "zod";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { PublicLotMap, type PublicLotParcel } from "../components/public/PublicLotMap";
import { WamuleClassicBuildStamp, WamuleClassicHeader, WamuleClassicHero, WamuleClassicInfoTile, WamuleClassicNotice, WamuleClassicPanel } from "../components/public/WamuleClassicTemplate";
import { applicationSchema } from "../lib/schemas";
import { submitPublicFunction } from "../lib/publicSubmission";
import { isLocalOnlySubmission } from "../lib/publicSubmissionMode";
import { defaultPublicExperience, type PublicSiteModuleId, type PublicSiteTemplateId } from "../lib/publicExperience.mjs";
import { usePublicSiteExperience } from "../lib/publicSiteExperience";
import { buildInquiryPayload, type InquiryInterest } from "../../supabase/functions/_shared/inquiry-contract";
import { buildPublicApplicationPayload } from "../../supabase/functions/_shared/public-application-contract";
import { CANONICAL_COMPANY_NAME, defaultCompanyProfile } from "../lib/brand";
import { hasSupabaseConfig, supabase } from "../lib/supabase";
import { cn, money } from "../lib/utils";
import type { BusinessSetting, InstallmentPlan, PaymentMethod } from "../types/database";

type ApplicationValues = z.infer<typeof applicationSchema>;
type PublicParcelOption = {
  public_ref: string;
  local_key: number;
  lot_number: string;
  status: string | null;
  sales_selectable: boolean;
  base_price: number;
  dimensions: string | null;
};

const inquiryInterests: readonly InquiryInterest[] = [
  "Available lots",
  "Lot pricing",
  "Payment options",
  "Site visit",
  "Buying process",
  "A specific lot",
] as const;

const specificLotInterest: InquiryInterest = "A specific lot";
const PUBLIC_WAMULE_SCOPE = { tenantSlug: "wamule", projectSlug: "wamule", phaseSlug: "default" } as const;

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

const intendedUseOptions = [
  "Residential",
  "Commercial",
  "Agriculture",
  "Investment",
  "Rental Property",
  "Other",
] as const;

const applicationSteps = [
  { id: 0, label: "About You", goal: "Tell us who you are." },
  { id: 1, label: "Land Interest", goal: "What are you hoping to use the land for?" },
  { id: 2, label: "Preferred Lot", goal: "Which available lot are you most interested in?" },
  { id: 3, label: "Payment Preference", goal: "How would you like to move forward?" },
  { id: 4, label: "Review", goal: "Review and acknowledge before submitting." },
] as const;

function applicationStepForField(field: string) {
  if (["applicant_full_name", "applicant_address", "nationality", "occupation", "phone", "email"].includes(field)) return 0;
  if (["intended_use", "intended_use_other", "parcel_count"].includes(field)) return 1;
  if (["preferred_lot_refs", "alternate_lot_preference"].includes(field)) return 2;
  if (["payment_option", "notes"].includes(field)) return 3;
  return 4;
}

const defaultCompany = defaultCompanyProfile;

const defaultApplicationSettings = {
  applications_open: true,
  public_notice_text:
    `Submission of this application is solely a request to be considered for the purchase of a lot within ${CANONICAL_COMPANY_NAME}. Submission or acceptance of this application does not create any legal right to purchase land, does not reserve a lot, and does not guarantee that any lot will be sold or transferred to the applicant.`,
  application_acknowledgment_text:
    `By signing this application, I acknowledge and understand that submission does not guarantee approval or allocation of a lot; approval is subject to availability and acceptance by ${CANONICAL_COMPANY_NAME}; the reservation fee is non-refundable and paid to reserve a selected lot; final selection is subject to inspection and confirmation; only a signed purchase agreement may result in ownership transfer; utilities and closing charges may be applicant responsibilities; and this application is not a sale agreement.`,
  show_lot_prices_publicly: true,
  show_available_lot_count_publicly: true,
  lot_map_tenant_slug: "",
  default_confirmation_message: `Application submitted. A ${CANONICAL_COMPANY_NAME} representative will contact you after review.`,
};

const defaultLotPhase = {
  phase_name: "Phase 1",
  default_lot_size: "65 x 101 or 75 x 101 ft",
  default_lot_price: 25000,
  public_availability_display: true,
};

export function ApplicationPage({
  templateId: selectedTemplate,
  enabledModules: selectedModules,
}: {
  templateId?: PublicSiteTemplateId;
  enabledModules?: Record<PublicSiteModuleId, boolean>;
} = {}) {
  const location = useLocation();
  const { data: siteExperience } = usePublicSiteExperience(PUBLIC_WAMULE_SCOPE);
  const experience = siteExperience ?? defaultPublicExperience(PUBLIC_WAMULE_SCOPE);
  const templateId = selectedTemplate ?? experience.templateId;
  const modules = selectedModules ?? experience.enabledModules;
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const {
    data: publicSettings,
    isLoading: publicSettingsLoading,
    isError: publicSettingsError,
  } = useQuery({
    queryKey: ["public-business-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_settings")
        .select("*")
        .in("key", ["company_profile", "public_application", "lot_phase"]);
      if (error) throw error;
      return data as BusinessSetting[];
    },
    enabled: hasSupabaseConfig,
  });
  const companyProfile = settingValue<typeof defaultCompany>(publicSettings, "company_profile");
  const hasCompanyProfile = publicSettings?.some((setting) => setting.key === "company_profile") ?? false;
  const company = { ...defaultCompany, ...companyProfile };
  const applicationSettings = {
    ...defaultApplicationSettings,
    ...settingValue<typeof defaultApplicationSettings>(publicSettings, "public_application"),
  };
  const lotPhase = { ...defaultLotPhase, ...settingValue<typeof defaultLotPhase>(publicSettings, "lot_phase") };
  const configuredTenantSlug = applicationSettings.lot_map_tenant_slug;
  const applicationTenantSlug = typeof configuredTenantSlug === "string" ? configuredTenantSlug.trim().toLowerCase() : "";
  const { data: parcels = [], isLoading, isError: parcelsError, error: parcelLoadError } = useQuery({
    queryKey: ["public-application-lots", applicationTenantSlug],
    queryFn: async () => {
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
      if (!baseUrl || !anonKey) throw new Error("The public lot service is not configured.");
      const response = await fetch(
        `${baseUrl}/functions/v1/get-public-lots?tenant=${encodeURIComponent(applicationTenantSlug)}`,
        { headers: { apikey: anonKey } },
      );
      const body = await response.json().catch(() => ({})) as {
        parcels?: Array<Record<string, unknown>>;
        error?: string;
      };
      if (!response.ok || !Array.isArray(body.parcels)) throw new Error(body.error || "Could not load the current lot list.");
      return body.parcels
        .map((parcel, index) => ({
          public_ref: typeof parcel.public_ref === "string" ? parcel.public_ref : "",
          local_key: index + 1,
          lot_number: typeof parcel.lot_number === "string" ? parcel.lot_number : "",
          status: typeof parcel.status === "string" ? parcel.status : null,
          sales_selectable: parcel.sales_selectable === true,
          base_price: Number(parcel.price ?? 0),
          dimensions: typeof parcel.dimensions === "string" ? parcel.dimensions : null,
        }))
        .filter((parcel) => parcel.public_ref && parcel.status === "Available" && parcel.sales_selectable);
    },
    enabled: hasSupabaseConfig && Boolean(applicationTenantSlug),
  });
  const { data: installmentPlans } = useQuery({
    queryKey: ["public-installment-plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("installment_plans")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as InstallmentPlan[];
    },
    enabled: hasSupabaseConfig,
  });
  const { data: paymentMethods } = useQuery({
    queryKey: ["public-payment-methods"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_methods")
        .select("*")
        .eq("is_active", true)
        .eq("is_public", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as PaymentMethod[];
    },
    enabled: hasSupabaseConfig,
  });

  const form = useForm<ApplicationValues>({
    resolver: zodResolver(applicationSchema),
    defaultValues: {
      preferred_lot_refs: [],
      sustainability_terms_verified: true,
      legal_notice_acknowledged: false,
    },
  });
  const selectedLotRefs = form.watch("preferred_lot_refs") ?? [];
  const selectedLocalKeys = parcels
    .filter((parcel) => selectedLotRefs.includes(parcel.public_ref))
    .map((parcel) => parcel.local_key);
  const intendedUse = form.watch("intended_use");
  const watchedValues = form.watch();
  function toggleMapLot(parcel: PublicLotParcel) {
    if (!parcel.public_ref) return;
    const current = form.getValues("preferred_lot_refs") ?? [];
    const next = current.includes(parcel.public_ref)
      ? current.filter((reference) => reference !== parcel.public_ref)
      : [...current, parcel.public_ref];
    form.setValue("preferred_lot_refs", next, { shouldValidate: true });
  }

  useEffect(() => {
    if (location.pathname === "/apply") {
      window.requestAnimationFrame(() => {
        document.getElementById("application")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [location.pathname]);

  async function onSubmit(values: ApplicationValues) {
    setSubmitError(null);
    if (!applicationSettings.applications_open) {
      setSubmitError("Applications are currently closed.");
      return;
    }
    if (!applicationTenantSlug) {
      setSubmitError("This application page is not configured. Please contact the development team.");
      return;
    }
    if (isLocalOnlySubmission) {
      setSubmitted(true);
      form.reset({ preferred_lot_refs: [], sustainability_terms_verified: true, legal_notice_acknowledged: false });
      return;
    }
    try {
      await submitPublicFunction("submit-public-application", buildPublicApplicationPayload({ tenant: applicationTenantSlug, ...values }));
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : "We could not submit your application. Please try again.");
      return;
    }
    setSubmitted(true);
    form.reset({
      preferred_lot_refs: [],
      sustainability_terms_verified: true,
      legal_notice_acknowledged: false,
    });
  }

  const availableLots = parcels?.length ?? 0;
  const visiblePlans = installmentPlans?.length ? installmentPlans : fallbackApplicationPlans();
  const summaryRows = buildApplicationSummaryRows({
    activeStep,
    values: watchedValues,
    selectedLotRefs,
    parcels,
  });

  // The public page must never flash a bundled brand before the admin-managed
  // company profile arrives. In a configured environment, branding is rendered
  // only after the public settings query succeeds.
  if (hasSupabaseConfig && publicSettingsLoading) {
    return <PublicPageLoading />;
  }

  if (hasSupabaseConfig && (publicSettingsError || !hasCompanyProfile)) {
    return <PublicSettingsUnavailable />;
  }

  function scrollToInquiry() {
    document.getElementById("request-info")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main data-site-template={templateId} data-site-map={modules.map} className="min-h-screen bg-background">
      <WamuleClassicHeader
        companyName={company.company_name}
        logoUrl={company.logo_url || "/favicon/android-chrome-192x192.png"}
        applyHref="#application"
        showApply={modules.application}
      />

      <WamuleClassicHero
        badge={<Badge tone={applicationSettings.applications_open ? "green" : "amber"}>{lotPhase.phase_name} applications {applicationSettings.applications_open ? "open" : "closed"}</Badge>}
        title={`${company.company_name} Land Application`}
        description={company.short_description || `Apply to be considered for property within ${company.company_name}.`}
        facts={<>
          <WamuleClassicInfoTile label="Starting price" value={applicationSettings.show_lot_prices_publicly && modules.pricing ? money(Number(lotPhase.default_lot_price || 0)) : "Contact office"} />
          <WamuleClassicInfoTile label="Lot sizes" value={lotPhase.default_lot_size} />
          <WamuleClassicInfoTile label={lotPhase.phase_name} value={applicationSettings.show_available_lot_count_publicly ? `${availableLots} available` : "Availability by review"} />
        </>}
        actions={modules.application ? <a className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]" href="#application">
          Start application <ArrowRight className="h-4 w-4" />
        </a> : null}
        sideContent={<WamuleClassicPanel
          id="lots"
          title="Available Lot Preferences"
          description="Select preferred lots in the application below."
          trailing={lotPhase.public_availability_display && applicationSettings.show_available_lot_count_publicly ? <Badge tone="green">{availableLots} available</Badge> : null}
        >
          {!lotPhase.public_availability_display ? (
            <div className="rounded-md border border-dashed bg-muted p-5 text-sm text-muted-foreground">
              Lot availability is confirmed by {company.company_name} staff during application review.
            </div>
          ) : isLoading ? (
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
        </WamuleClassicPanel>}
      />

      {modules.inquiry ? <section className="mx-auto max-w-6xl px-4 pb-5" id="request-info">
        <PublicInquiryPanel
          companyName={company.company_name}
          tenantSlug={applicationTenantSlug}
          parcels={parcels}
          showPrices={applicationSettings.show_lot_prices_publicly && modules.pricing}
          hasSupabaseConfig={hasSupabaseConfig}
        />
      </section> : null}

      <WamuleClassicNotice
        notice={applicationSettings.public_notice_text}
        companyName={company.company_name}
        location={company.location_address}
      />

      {modules.application ? <section className="mx-auto max-w-6xl px-4 py-10 lg:py-12" id="application">
        <div className="mb-6 grid gap-4 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-secondary">Application</p>
            <h2 className="mt-2 break-words font-display text-3xl font-semibold tracking-normal text-primary sm:text-4xl">Apply for a lot</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Tell us about yourself, choose your preferred lot, and share how you would like to move forward. Submitting an application does not reserve a lot or guarantee approval.
            </p>
          </div>
          <div className="grid gap-2 rounded-xl border border-secondary/25 bg-[#fff8e6] p-4 text-sm text-primary shadow-sm shadow-secondary/10">
            <p className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-secondary" />Applications are reviewed by {company.company_name} staff.</p>
            <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-secondary" />Preferred lots are requests only and do not reserve land.</p>
          </div>
        </div>

        <div className="mb-5 overflow-x-auto rounded-xl border border-primary/15 bg-primary-soft/35 p-2 shadow-sm shadow-primary/5">
          <div className="flex min-w-max gap-2">
            {applicationSteps.map((step) => {
              const complete = activeStep > step.id;
              const active = activeStep === step.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  className={cn(
                    "flex min-h-11 min-w-[8.75rem] items-center gap-3 rounded-lg px-4 text-left text-sm font-medium transition",
                    active ? "bg-primary text-white shadow-sm shadow-primary/10" : complete ? "bg-card text-primary" : "bg-card/75 text-slate hover:bg-card hover:text-primary",
                  )}
                  onClick={() => setActiveStep(step.id)}
                >
                  <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold", active ? "bg-white text-primary" : complete ? "bg-success/10 text-success" : "bg-white text-slate")}>
                    {complete ? "✓" : step.id + 1}
                  </span>
                  <span className="whitespace-nowrap">{step.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Card className="overflow-hidden rounded-xl border-primary/15 shadow-[0_20px_60px_rgba(45,35,23,0.10)]">
          <CardContent className="p-0">
            {!hasSupabaseConfig ? <ErrorState message="Supabase environment variables are missing." /> : null}
            {submitted ? (
              <div className="crm-success-panel m-5 p-4 text-sm">
                {isLocalOnlySubmission ? "Local preview complete. No application was saved or sent." : applicationSettings.default_confirmation_message}
              </div>
            ) : !applicationSettings.applications_open ? (
              <div className="crm-warning-panel m-5 p-4 text-sm">
                Applications are currently closed. {applicationSettings.public_notice_text}
              </div>
            ) : (
              <form
                onSubmit={form.handleSubmit(onSubmit, (errors) => {
                  const firstField = Object.keys(errors)[0];
                  if (firstField) setActiveStep(applicationStepForField(firstField));
                })}
              >
                {submitError ? <div className="p-5 pb-0"><ErrorState message={submitError} /></div> : null}
                <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="min-w-0 p-5 lg:p-7">
                    {activeStep === 0 ? (
                      <FormStep title="About You" goal={applicationSteps[0].goal}>
                        <div className="grid gap-4 md:grid-cols-2">
                          <Field label="Applicant Full Name" error={form.formState.errors.applicant_full_name?.message}>
                            <Input {...form.register("applicant_full_name")} />
                          </Field>
                          <Field label="Applicant Address" error={form.formState.errors.applicant_address?.message}>
                            <Input {...form.register("applicant_address")} />
                          </Field>
                          <Field label="Nationality" error={form.formState.errors.nationality?.message}>
                            <Input {...form.register("nationality")} />
                          </Field>
                          <Field label="Occupation" error={form.formState.errors.occupation?.message}>
                            <Input {...form.register("occupation")} />
                          </Field>
                          <Field label="Telephone Contact" error={form.formState.errors.phone?.message}>
                            <Input {...form.register("phone")} />
                          </Field>
                          <Field label="Email Address" error={form.formState.errors.email?.message}>
                            <Input type="email" {...form.register("email")} />
                          </Field>
                        </div>
                      </FormStep>
                    ) : null}

                    {activeStep === 1 ? (
                      <FormStep title="Your Land Interest" goal={applicationSteps[1].goal}>
                        <Field label="The lot is intended for" error={form.formState.errors.intended_use?.message}>
                          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {intendedUseOptions.map((option) => (
                              <ChoiceCard key={option} selected={intendedUse === option}>
                                <input type="radio" value={option} {...form.register("intended_use")} />
                                <span>{option}</span>
                              </ChoiceCard>
                            ))}
                          </div>
                        </Field>
                        {intendedUse === "Other" ? (
                          <Field label="Other intended use" error={form.formState.errors.intended_use_other?.message}>
                            <Input {...form.register("intended_use_other")} />
                          </Field>
                        ) : null}
                        <Field label="Number of parcels interested in purchasing" error={form.formState.errors.parcel_count?.message}>
                          <Input type="number" min="1" {...form.register("parcel_count")} />
                        </Field>
                      </FormStep>
                    ) : null}

                    {activeStep === 2 ? (
                      <FormStep title="Choose Your Preferred Lot" goal={applicationSteps[2].goal}>
                        {modules.map && (applicationSettings.lot_map_tenant_slug || import.meta.env.DEV) ? (
                          <div className="grid gap-2">
                            <div className="h-[560px] overflow-hidden rounded-xl border border-border lg:h-[640px]">
                              <PublicLotMap
                                tenantSlug={applicationTenantSlug || "demo"}
                                selectedLocalKeys={selectedLocalKeys}
                                onToggleLot={toggleMapLot}
                                showPrices={applicationSettings.show_lot_prices_publicly && modules.pricing}
                                demoDataUrl={
                                  applicationSettings.lot_map_tenant_slug || !import.meta.env.DEV
                                    ? undefined
                                    : "/demo-map"
                                }
                              />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Tap an available lot on the map to add it to your preferences. Selected lots also appear below.
                            </p>
                          </div>
                        ) : null}
                        <Field label="Preferred lots" error={form.formState.errors.preferred_lot_refs?.message}>
                          {isLoading ? (
                            <LoadingState label="Loading available lots" />
                          ) : (
                            <div className="grid gap-3">
                              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                                {parcels?.map((parcel) => {
                                  const selected = selectedLotRefs.includes(parcel.public_ref);
                                  return (
                                    <label
                                      key={parcel.public_ref}
                                      className={cn(
                                        "relative cursor-pointer rounded-xl border p-4 text-sm font-normal transition",
                                        selected ? "border-primary bg-primary-soft ring-1 ring-primary" : "border-border bg-card hover:border-primary/40 hover:bg-primary-soft/30",
                                      )}
                                    >
                                      <input className="sr-only" type="checkbox" value={parcel.public_ref} {...form.register("preferred_lot_refs")} />
                                      <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Lot</span>
                                      <span className="mt-1 block text-2xl font-semibold text-primary">{parcel.lot_number}</span>
                                      <span className="mt-2 block text-sm text-muted-foreground">{parcel.dimensions}</span>
                                      {applicationSettings.show_lot_prices_publicly && modules.pricing ? <span className="mt-3 block font-semibold text-primary">{money(parcel.base_price)}</span> : null}
                                      <span className={cn("absolute right-3 top-3 rounded-full px-2 py-1 text-xs font-semibold", selected ? "bg-primary text-white" : "bg-success/10 text-success")}>
                                        {selected ? "Selected" : parcel.status}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                              {parcelsError ? (
                                <ErrorState message={parcelLoadError instanceof Error ? parcelLoadError.message : "Could not load the current lot list."} />
                              ) : parcels.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No available lots are currently listed.</p>
                              ) : null}
                            </div>
                          )}
                        </Field>
                        <div className="rounded-xl border border-primary/15 bg-primary-soft/35 p-4">
                          <p className="text-sm font-semibold text-primary">Alternative lot option</p>
                          <p className="mt-1 text-sm text-muted-foreground">Use this only if your first preference is unavailable.</p>
                          <div className="mt-4">
                            <Field label="Alternative lot option if your first preference is unavailable" error={form.formState.errors.alternate_lot_preference?.message}>
                              <Input {...form.register("alternate_lot_preference")} />
                            </Field>
                          </div>
                        </div>
                      </FormStep>
                    ) : null}

                    {activeStep === 3 ? (
                      <FormStep title="Payment Preference" goal={applicationSteps[3].goal}>
                        <div className="grid gap-6">
                          <div>
                            <p className="text-sm font-semibold text-primary">Payment plan</p>
                            <p className="mt-1 text-sm text-muted-foreground">Choose the plan you prefer for review. No payment is collected here.</p>
                            <Field label="Select one" error={form.formState.errors.payment_option?.message}>
                              <div className="grid gap-3 lg:grid-cols-2">
                                {visiblePlans.map((plan) => (
                                  <PaymentChoice key={plan.id} plan={plan} selected={watchedValues.payment_option === plan.name} register={form.register("payment_option")} />
                                ))}
                              </div>
                            </Field>
                          </div>
                          {paymentMethods?.length ? (
                            <div className="rounded-xl border border-border bg-card p-4">
                              <p className="text-sm font-semibold text-primary">How payments can be made</p>
                              <p className="mt-1 text-sm text-muted-foreground">These are current public payment methods for reference. The application does not create a payment record.</p>
                              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                {paymentMethods.map((method) => (
                                  <PaymentMethodCard key={method.id} method={method} />
                                ))}
                              </div>
                            </div>
                          ) : null}
                          <div className="rounded-xl border border-secondary/25 bg-[#fff8e6] p-4 shadow-sm shadow-secondary/10">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-primary">Still have questions before applying?</p>
                                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                                  Request project information if you want staff to follow up before you submit a formal application.
                                </p>
                              </div>
                              <Button type="button" variant="outline" className="shrink-0" onClick={scrollToInquiry}>
                                Request project information
                              </Button>
                            </div>
                          </div>
                          <Field label="Additional notes">
                            <Textarea {...form.register("notes")} />
                          </Field>
                        </div>
                      </FormStep>
                    ) : null}

                    {activeStep === 4 ? (
                      <FormStep title="Review & Acknowledge" goal={applicationSteps[4].goal}>
                        <ReviewSummary
                          values={watchedValues}
                          parcels={parcels}
                          showPrices={applicationSettings.show_lot_prices_publicly && modules.pricing}
                          onEdit={setActiveStep}
                        />
                        <div className="grid gap-4">
                          <label className="flex gap-3 rounded-xl border border-success/20 bg-success/10 p-4 text-sm">
                            <input type="checkbox" className="mt-1" {...form.register("legal_notice_acknowledged")} />
                            <span>
                              I acknowledge that submission of this application does not guarantee approval, reserve a lot, or create any legal right to purchase land.
                              {form.formState.errors.legal_notice_acknowledged ? (
                                <span className="mt-1 block text-danger">{form.formState.errors.legal_notice_acknowledged.message}</span>
                              ) : null}
                            </span>
                          </label>
                          <div className="rounded-xl border border-border bg-card p-4 text-sm leading-6 shadow-sm shadow-primary/5">
                            <p className="font-semibold text-primary">Applicant Acknowledgement</p>
                            <p className="mt-2 text-muted-foreground">{applicationSettings.application_acknowledgment_text}</p>
                            <div className="mt-4">
                              <Field label="Type your full name as acknowledgement" error={form.formState.errors.applicant_acknowledgement_signature?.message}>
                                <Input {...form.register("applicant_acknowledgement_signature")} />
                              </Field>
                            </div>
                          </div>
                        </div>
                      </FormStep>
                    ) : null}
                  </div>

                  <aside className="hidden border-primary/10 bg-primary/95 p-5 text-white lg:block lg:border-l lg:p-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/65">Application Summary</p>
                    <div className="mt-5 grid gap-2 text-sm">
                      <SummaryLine label="Step" value={`${activeStep + 1} of ${applicationSteps.length}`} />
                      {summaryRows.map((row) => (
                        <SummaryLine key={row.label} label={row.label} value={row.value} muted={row.muted} />
                      ))}
                    </div>
                    <div className="mt-6 rounded-lg border border-white/15 bg-white/[0.06] p-4 text-sm leading-6 text-white/80">
                      Submitting an application does not reserve a lot or guarantee approval.
                    </div>
                  </aside>
                </div>

                <div className="flex flex-col-reverse gap-3 border-t border-border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <Button type="button" variant="outline" disabled={activeStep === 0 || form.formState.isSubmitting} onClick={() => setActiveStep((step) => Math.max(step - 1, 0))}>
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  {activeStep < applicationSteps.length - 1 ? (
                    <Button type="button" onClick={() => setActiveStep((step) => Math.min(step + 1, applicationSteps.length - 1))}>
                      Continue
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button disabled={form.formState.isSubmitting}>Submit application</Button>
                  )}
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </section> : null}
      <footer className="mx-auto max-w-6xl border-t border-border px-4 py-5">
        <WamuleClassicBuildStamp scope={PUBLIC_WAMULE_SCOPE} />
      </footer>
    </main>
  );
}

export function PublicInquiryPanel({
  companyName,
  tenantSlug,
  projectSlug,
  phaseSlug,
  parcels,
  showPrices,
  hasSupabaseConfig,
  interestOptions,
  introPrompt,
  introDescription,
  introNotice,
  confirmationNote,
  footerNote,
  mapHref = "#lots",
  localDemoOnly = isLocalOnlySubmission,
}: {
  companyName: string;
  tenantSlug: string;
  projectSlug?: string;
  phaseSlug?: string;
  parcels: PublicParcelOption[];
  showPrices: boolean;
  hasSupabaseConfig: boolean;
  interestOptions?: readonly InquiryInterest[];
  introPrompt?: string;
  introDescription?: string;
  introNotice?: string;
  confirmationNote?: string;
  footerNote?: string;
  mapHref?: string;
  localDemoOnly?: boolean;
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
  const availableInterestOptions = interestOptions ?? inquiryInterests;

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
    if (localDemoOnly) {
      setSubmitted(true);
      setEmailSent(false);
      setName("");
      setEmail("");
      setPhone("");
      setInterests([]);
      setSpecificLotRef("");
      setMessage("");
      return;
    }
    if (!hasSupabaseConfig) {
      setError("Public inquiry submission is not configured in this environment.");
      return;
    }
    if (!tenantSlug) {
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
        tenant: tenantSlug,
        project: projectSlug,
        phase: phaseSlug,
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
            <h2 className="mt-2 font-display text-2xl font-semibold text-primary">{localDemoOnly ? "Local preview complete." : "Thanks — we received your request."}</h2>
          </div>
          <div className="rounded-xl border border-success/20 bg-success/10 p-4 text-sm leading-6 text-foreground">
            <p>{localDemoOnly ? "This request stayed in your browser. No inquiry was saved or sent." : "Our team will review your questions and follow up using the contact information you provided."}</p>
            <p className="mt-2 text-muted-foreground">
              {emailSent
                ? "A confirmation email was sent. Your request does not reserve a lot or guarantee approval."
                : confirmationNote || "Your request was saved. It does not reserve a lot or guarantee approval."}
            </p>
            <a className="mt-4 inline-flex font-semibold text-primary hover:text-primary-hover" href={mapHref}>
              Review project map and information
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
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-secondary">{introPrompt || "Not ready to apply yet?"}</p>
          <h2 className="mt-2 break-words font-display text-3xl font-semibold text-primary">Request project information</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            {introDescription || `Have questions about available lots, pricing, payment options, site visits, or the buying process? Tell us what you're interested in and the ${companyName} team can follow up.`}
          </p>
          <div className="mt-5 rounded-xl border border-primary/10 bg-primary-soft/45 p-4 text-sm leading-6 text-primary">
            {introNotice || "This is an information request only. It does not submit an application, reserve a lot, or guarantee approval."}
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
              {availableInterestOptions.map((interest) => {
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
              {footerNote || "Lot availability is not guaranteed or reserved by an inquiry."}
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

export function FormStep({ title, goal, children }: { title: string; goal: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-6">
      <div>
        <h3 className="font-display text-2xl font-semibold text-primary">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{goal}</p>
      </div>
      {children}
    </section>
  );
}

export function ChoiceCard({ selected, children }: { selected: boolean; children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border p-4 text-sm font-semibold transition",
        selected ? "border-primary bg-primary-soft text-primary ring-1 ring-primary" : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-primary-soft/25",
      )}
    >
      {children}
    </label>
  );
}

function PaymentChoice({
  plan,
  selected,
  register,
}: {
  plan: InstallmentPlan;
  selected: boolean;
  register: ReturnType<typeof useForm<ApplicationValues>>["register"] extends (...args: never[]) => infer R ? R : never;
}) {
  const details = [
    plan.description,
    `Reservation fee: ${money(Number(plan.reservation_fee))}`,
    Number(plan.monthly_payment) > 0 ? `${money(Number(plan.monthly_payment))} - ${plan.term_months} months` : `Purchase price: ${money(Number(plan.final_purchase_price))}`,
  ].filter(Boolean);

  return (
    <label
      className={cn(
        "grid cursor-pointer gap-2 rounded-xl border p-4 text-sm font-normal shadow-sm shadow-primary/5 transition",
        selected ? "border-primary bg-primary-soft ring-1 ring-primary" : "border-border bg-card hover:border-primary/30 hover:bg-primary-soft/25",
      )}
    >
      <span className="flex items-center gap-2 font-semibold">
        <input type="radio" value={plan.name} {...register} />
        {plan.name}
      </span>
      {details.map((detail) => (
        <span key={detail} className="text-muted-foreground">
          {detail}
        </span>
      ))}
    </label>
  );
}

function PaymentMethodCard({ method }: { method: PaymentMethod }) {
  return (
    <div className="rounded-xl border border-border bg-white p-4 text-sm shadow-sm shadow-primary/5">
      <p className="font-semibold text-primary">{method.name}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{method.method_type}</p>
      {[method.bank_name, method.account_name, method.account_number].filter(Boolean).length ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {[method.bank_name, method.account_name, method.account_number].filter(Boolean).join(" / ")}
        </p>
      ) : null}
      {method.instructions ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{method.instructions}</p> : null}
    </div>
  );
}

function ReviewSummary({
  values,
  parcels,
  showPrices,
  onEdit,
}: {
  values: Partial<ApplicationValues>;
  parcels: PublicParcelOption[];
  showPrices: boolean;
  onEdit: (step: number) => void;
}) {
  const preferredLots = values.preferred_lot_refs?.length
    ? values.preferred_lot_refs.map((reference) => {
      const parcel = parcels.find((item) => item.public_ref === reference);
      const price = parcel && showPrices ? ` · ${money(parcel.base_price)}` : "";
      return parcel ? `Lot ${parcel.lot_number} · ${parcel.dimensions}${price}` : "Lot no longer listed";
    }).join(", ")
    : "None selected";
  return (
    <div className="grid gap-4">
      <ReviewGroup title="Applicant" step={0} onEdit={onEdit} rows={[
        ["Name", values.applicant_full_name || "Not entered"],
        ["Phone", values.phone || "Not entered"],
        ["Email", values.email || "Not entered"],
      ]} />
      <ReviewGroup title="Land Interest" step={1} onEdit={onEdit} rows={[
        ["Intended use", `${values.intended_use || "Not selected"}${values.intended_use_other ? ` - ${values.intended_use_other}` : ""}`],
        ["Number of parcels", values.parcel_count ? String(values.parcel_count) : "Not entered"],
      ]} />
      <ReviewGroup title="Lot Preference" step={2} onEdit={onEdit} rows={[
        ["Preferred lot", preferredLots],
        ["Alternative lot", values.alternate_lot_preference || "Not entered"],
      ]} />
      <ReviewGroup title="Payment Preference" step={3} onEdit={onEdit} rows={[
        ["Plan", values.payment_option || "Not selected"],
        ["Method", "Available payment methods are shown for reference; no payment is made in this application."],
      ]} />
      {values.notes ? <ReviewGroup title="Additional Notes" step={3} onEdit={onEdit} rows={[["Notes", values.notes]]} /> : null}
    </div>
  );
}

function ReviewGroup({ title, step, rows, onEdit }: { title: string; step: number; rows: Array<[string, string]>; onEdit: (step: number) => void }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm shadow-primary/5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-primary">{title}</p>
        <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={() => onEdit(step)}>Edit</Button>
      </div>
      <div className="mt-3 grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-b border-border/70 pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[140px_minmax(0,1fr)]">
            <span className="text-muted-foreground">{label}</span>
            <span className="break-words font-medium text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildApplicationSummaryRows({
  activeStep,
  values,
  selectedLotRefs,
  parcels,
}: {
  activeStep: number;
  values: Partial<ApplicationValues>;
  selectedLotRefs: ApplicationValues["preferred_lot_refs"];
  parcels: PublicParcelOption[];
}) {
  const rows: Array<{ label: string; value: string; muted?: boolean }> = [];
  const addRow = (label: string, value: string | number | undefined | null, emptyValue: string) => {
    const displayValue = value === undefined || value === null || value === "" ? emptyValue : String(value);
    rows.push({ label, value: displayValue, muted: displayValue === emptyValue });
  };

  addRow("Applicant", values.applicant_full_name, "Not entered");

  if (activeStep >= 1 || values.intended_use || values.parcel_count) {
    addRow("Intended use", values.intended_use === "Other" && values.intended_use_other ? values.intended_use_other : values.intended_use, "Not selected");
    addRow("Parcels", values.parcel_count, "Not entered");
  }

  if (activeStep >= 2 || selectedLotRefs?.length || values.alternate_lot_preference) {
    const preferredLots = selectedLotRefs?.length
      ? selectedLotRefs.map((reference) => lotLabel(parcels, reference)).join(", ")
      : undefined;
    addRow("Preferred lot", preferredLots, "Not selected");
    if (activeStep >= 2 || values.alternate_lot_preference) addRow("Alternative", values.alternate_lot_preference, "Not entered");
  }

  if (activeStep >= 3 || values.payment_option) {
    addRow("Payment plan", values.payment_option, "Not selected");
  }

  return rows;
}

export function SummaryLine({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/15 pb-3 last:border-b-0 last:pb-0">
      <span className="text-white/60">{label}</span>
      <span className={cn("max-w-[12rem] break-words text-right font-semibold", muted ? "text-white/60" : "text-white")}>{value}</span>
    </div>
  );
}

function PublicPageLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-sm">
        <LoadingState label="Loading application information…" />
      </div>
    </main>
  );
}

function PublicSettingsUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-sm">
        <h1 className="font-display text-xl font-semibold text-primary">Application information is unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Please try again shortly. If the problem continues, contact the project office.</p>
      </div>
    </main>
  );
}

function lotLabel(parcels: PublicParcelOption[], reference: string) {
  const parcel = parcels.find((item) => item.public_ref === reference);
  return parcel ? `Lot ${parcel.lot_number}` : "Lot no longer listed";
}

function settingValue<T>(settings: BusinessSetting[] | undefined, key: string) {
  return (settings?.find((setting) => setting.key === key)?.value ?? {}) as Partial<T>;
}

function fallbackApplicationPlans(): InstallmentPlan[] {
  return [
    {
      id: -1,
      name: "Installment Plan - 60 months",
      description: "$2,500 reservation fee, $375.00 monthly",
      reservation_fee: 2500,
      initial_deposit: 2500,
      final_purchase_price: 25000,
      term_months: 60,
      monthly_payment: 375,
      is_active: true,
      sort_order: 30,
      created_at: "",
      updated_at: "",
    },
    {
      id: -2,
      name: "Paid in Full",
      description: "$2,500 reservation fee, remaining balance due at purchase agreement",
      reservation_fee: 2500,
      initial_deposit: 2500,
      final_purchase_price: 25000,
      term_months: 1,
      monthly_payment: 0,
      is_active: true,
      sort_order: 40,
      created_at: "",
      updated_at: "",
    },
  ];
}
