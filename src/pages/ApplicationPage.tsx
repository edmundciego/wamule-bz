import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, HelpCircle, MapPin, Send, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useLocation } from "react-router-dom";
import type { z } from "zod";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { applicationSchema } from "../lib/schemas";
import { CANONICAL_COMPANY_NAME, defaultCompanyProfile } from "../lib/brand";
import { hasSupabaseConfig, supabase } from "../lib/supabase";
import { cn, money } from "../lib/utils";
import type { BusinessSetting, InstallmentPlan, PaymentMethod } from "../types/database";

type ApplicationValues = z.infer<typeof applicationSchema>;
type PublicParcelOption = {
  id: number;
  lot_number: string | null;
  status: string | null;
  base_price: number;
  dimensions: string | null;
};

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
  if (["preferred_parcel_ids", "alternate_lot_preference"].includes(field)) return 2;
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
  default_confirmation_message: `Application submitted. A ${CANONICAL_COMPANY_NAME} representative will contact you after review.`,
};

const defaultLotPhase = {
  phase_name: "Phase 1",
  default_lot_size: "65 x 101 or 75 x 101 ft",
  default_lot_price: 25000,
  public_availability_display: true,
};

export function ApplicationPage() {
  const location = useLocation();
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
  const { data: parcels, isLoading } = useQuery({
    queryKey: ["public-parcel-options"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("public_parcel_options")
        .select("id, lot_number, status, base_price, dimensions")
        .order("lot_number");
      if (error) throw error;
      return data;
    },
    enabled: hasSupabaseConfig,
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
      preferred_parcel_ids: [],
      sustainability_terms_verified: true,
      legal_notice_acknowledged: false,
    },
  });
  const selectedLotIds = form.watch("preferred_parcel_ids") ?? [];
  const intendedUse = form.watch("intended_use");
  const watchedValues = form.watch();

  useEffect(() => {
    if (location.pathname === "/apply") {
      window.requestAnimationFrame(() => {
        document.getElementById("application")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [location.pathname]);

  function splitApplicantName(fullName: string) {
    const parts = fullName.trim().split(/\s+/);
    return {
      first_name: parts[0] ?? fullName.trim(),
      last_name: parts.slice(1).join(" ") || parts[0] || "Applicant",
    };
  }

  async function onSubmit(values: ApplicationValues) {
    setSubmitError(null);
    if (!applicationSettings.applications_open) {
      setSubmitError("Applications are currently closed.");
      return;
    }
    const { first_name, last_name } = splitApplicantName(values.applicant_full_name);
    const { error } = await supabase.from("applications").insert({
      first_name,
      last_name,
      applicant_full_name: values.applicant_full_name,
      applicant_address: values.applicant_address,
      nationality: values.nationality,
      occupation: values.occupation,
      phone: values.phone,
      email: values.email,
      intended_use: values.intended_use,
      intended_use_other: values.intended_use_other || null,
      parcel_count: values.parcel_count,
      preferred_parcel_ids: values.preferred_parcel_ids,
      alternate_lot_preference: values.alternate_lot_preference,
      payment_option: values.payment_option,
      legal_notice_acknowledged: values.legal_notice_acknowledged,
      applicant_acknowledgement_signature: values.applicant_acknowledgement_signature,
      notes: values.notes || null,
      cultural_preservation_review:
        `Applicant acknowledged the ${company.company_name} application notice, reservation terms, and applicant acknowledgement.`,
      sustainability_terms_verified: values.sustainability_terms_verified,
      status: "Pending Review",
    });
    if (error) {
      setSubmitError(error.message);
      return;
    }
    setSubmitted(true);
    form.reset({
      preferred_parcel_ids: [],
      sustainability_terms_verified: true,
      legal_notice_acknowledged: false,
    });
  }

  const companyProfile = settingValue<typeof defaultCompany>(publicSettings, "company_profile");
  const hasCompanyProfile = publicSettings?.some((setting) => setting.key === "company_profile") ?? false;
  const company = { ...defaultCompany, ...companyProfile };
  const applicationSettings = {
    ...defaultApplicationSettings,
    ...settingValue<typeof defaultApplicationSettings>(publicSettings, "public_application"),
  };
  const lotPhase = { ...defaultLotPhase, ...settingValue<typeof defaultLotPhase>(publicSettings, "lot_phase") };
  const availableLots = parcels?.length ?? 0;
  const visiblePlans = installmentPlans?.length ? installmentPlans : fallbackApplicationPlans();
  const summaryRows = buildApplicationSummaryRows({
    activeStep,
    values: watchedValues,
    selectedLotIds,
    parcels: parcels ?? [],
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
    <main className="min-h-screen bg-background">
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
            <a
              className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]"
              href="#application"
            >
              Apply <ArrowRight className="h-4 w-4" />
            </a>
          </nav>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-14">
        <div className="min-w-0">
          <Badge tone={applicationSettings.applications_open ? "green" : "amber"}>
            {lotPhase.phase_name} applications {applicationSettings.applications_open ? "open" : "closed"}
          </Badge>
          <h1 className="mt-5 max-w-3xl break-words font-display text-4xl font-semibold tracking-normal text-primary sm:text-5xl">
            {company.company_name} Land Application
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
            {company.short_description || `Apply to be considered for property within ${company.company_name}.`}
          </p>
          <div className="wave-rule mt-6 h-3 w-56" />
          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <InfoTile label="Starting price" value={applicationSettings.show_lot_prices_publicly ? money(Number(lotPhase.default_lot_price || 0)) : "Contact office"} />
            <InfoTile label="Lot sizes" value={lotPhase.default_lot_size} />
            <InfoTile label={lotPhase.phase_name} value={applicationSettings.show_available_lot_count_publicly ? `${availableLots} available` : "Availability by review"} />
          </div>
          <div className="mt-7 flex flex-wrap gap-3">
            <a className="focus-ring inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-primary-hover hover:shadow-[var(--shadow-button)]" href="#application">
              Start application <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>

        <div id="lots" className="min-w-0 overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-card)]">
          <div className="brand-pattern h-4 border-b" />
          <div className="p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="font-display text-xl font-semibold text-primary">Available Lot Preferences</p>
                <p className="text-sm text-muted-foreground">Select preferred lots in the application below.</p>
              </div>
              {lotPhase.public_availability_display && applicationSettings.show_available_lot_count_publicly ? <Badge tone="green">{availableLots} available</Badge> : null}
            </div>
            {!lotPhase.public_availability_display ? (
              <div className="rounded-md border border-dashed bg-muted p-5 text-sm text-muted-foreground">
                Lot availability is confirmed by {company.company_name} staff during application review.
              </div>
            ) : isLoading ? (
              <LoadingState label="Loading lot availability" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {parcels?.slice(0, 4).map((parcel) => (
                  <div key={parcel.id} className="rounded-lg border border-success/20 bg-success/10 p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <strong className="text-primary">Lot {parcel.lot_number}</strong>
                      <span className="rounded-full bg-success/10 px-2 py-1 text-xs font-semibold text-success">{parcel.status}</span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{parcel.dimensions}</p>
                    {applicationSettings.show_lot_prices_publicly ? <span className="mt-2 block font-semibold text-success">{money(parcel.base_price)}</span> : null}
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

      <section className="mx-auto max-w-6xl px-4 pb-5" id="request-info">
        <PublicInquiryPanel
          companyName={company.company_name}
          parcels={parcels ?? []}
          showPrices={applicationSettings.show_lot_prices_publicly}
          hasSupabaseConfig={hasSupabaseConfig}
        />
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-4" id="notice">
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
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 lg:py-12" id="application">
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
                {applicationSettings.default_confirmation_message}
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
                        <Field label="Preferred lots" error={form.formState.errors.preferred_parcel_ids?.message}>
                          {isLoading ? (
                            <LoadingState label="Loading available lots" />
                          ) : (
                            <div className="grid gap-3">
                              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                                {parcels?.map((parcel) => {
                                  const selected = selectedLotIds.map(Number).includes(parcel.id);
                                  return (
                                    <label
                                      key={parcel.id}
                                      className={cn(
                                        "relative cursor-pointer rounded-xl border p-4 text-sm font-normal transition",
                                        selected ? "border-primary bg-primary-soft ring-1 ring-primary" : "border-border bg-card hover:border-primary/40 hover:bg-primary-soft/30",
                                      )}
                                    >
                                      <input className="sr-only" type="checkbox" value={parcel.id} {...form.register("preferred_parcel_ids")} />
                                      <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Lot</span>
                                      <span className="mt-1 block text-2xl font-semibold text-primary">{parcel.lot_number}</span>
                                      <span className="mt-2 block text-sm text-muted-foreground">{parcel.dimensions}</span>
                                      {applicationSettings.show_lot_prices_publicly ? <span className="mt-3 block font-semibold text-primary">{money(parcel.base_price)}</span> : null}
                                      <span className={cn("absolute right-3 top-3 rounded-full px-2 py-1 text-xs font-semibold", selected ? "bg-primary text-white" : "bg-success/10 text-success")}>
                                        {selected ? "Selected" : parcel.status}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                              {parcels?.length === 0 ? <p className="text-sm text-muted-foreground">No available lots are currently listed.</p> : null}
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
                          parcels={parcels ?? []}
                          showPrices={applicationSettings.show_lot_prices_publicly}
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
      </section>
    </main>
  );
}

function PublicInquiryPanel({
  companyName,
  parcels,
  showPrices,
  hasSupabaseConfig,
}: {
  companyName: string;
  parcels: PublicParcelOption[];
  showPrices: boolean;
  hasSupabaseConfig: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [interests, setInterests] = useState<InquiryInterest[]>([]);
  const [specificLotId, setSpecificLotId] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [emailSent, setEmailSent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const specificLotSelected = interests.includes(specificLotInterest);

  function toggleInterest(interest: InquiryInterest) {
    setInterests((current) => {
      const next = current.includes(interest) ? current.filter((item) => item !== interest) : [...current, interest];
      if (interest === specificLotInterest && current.includes(interest)) setSpecificLotId("");
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
    if (specificLotSelected && !specificLotId) {
      setError("Choose the specific lot you would like information about.");
      return;
    }
    if (!hasSupabaseConfig) {
      setError("Public inquiry submission is not configured in this environment.");
      return;
    }

    setSubmitting(true);
    const { data, error: functionError } = await supabase.functions.invoke("submit-public-inquiry", {
      body: {
        name,
        email,
        phone,
        interests,
        specific_lot_id: specificLotSelected && specificLotId ? Number(specificLotId) : null,
        message,
        page_url: window.location.href,
      },
    });
    setSubmitting(false);

    if (functionError || data?.error) {
      setError(String(data?.error ?? functionError?.message ?? "We could not submit your request. Please try again."));
      return;
    }

    setSubmitted(true);
    setEmailSent(Boolean(data?.emailSent));
    setName("");
    setEmail("");
    setPhone("");
    setInterests([]);
    setSpecificLotId("");
    setMessage("");
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
              <Select value={specificLotId} onChange={(event) => setSpecificLotId(event.target.value)}>
                <option value="">Select a lot</option>
                {parcels.map((parcel) => (
                  <option key={parcel.id} value={parcel.id}>
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

function FormStep({ title, goal, children }: { title: string; goal: string; children: React.ReactNode }) {
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

function ChoiceCard({ selected, children }: { selected: boolean; children: React.ReactNode }) {
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
  parcels: Array<{ id: number; lot_number: string | null; base_price: number; dimensions: string | null }>;
  showPrices: boolean;
  onEdit: (step: number) => void;
}) {
  const preferredLots = values.preferred_parcel_ids?.length
    ? values.preferred_parcel_ids.map((id) => {
      const parcel = parcels.find((item) => item.id === Number(id));
      const price = parcel && showPrices ? ` · ${money(parcel.base_price)}` : "";
      return parcel ? `Lot ${parcel.lot_number} · ${parcel.dimensions}${price}` : `Lot ${id}`;
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
  selectedLotIds,
  parcels,
}: {
  activeStep: number;
  values: Partial<ApplicationValues>;
  selectedLotIds: ApplicationValues["preferred_parcel_ids"];
  parcels: Array<{ id: number; lot_number: string | null }>;
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

  if (activeStep >= 2 || selectedLotIds?.length || values.alternate_lot_preference) {
    const preferredLots = selectedLotIds?.length
      ? selectedLotIds.map((id) => lotLabel(parcels, Number(id))).join(", ")
      : undefined;
    addRow("Preferred lot", preferredLots, "Not selected");
    if (activeStep >= 2 || values.alternate_lot_preference) addRow("Alternative", values.alternate_lot_preference, "Not entered");
  }

  if (activeStep >= 3 || values.payment_option) {
    addRow("Payment plan", values.payment_option, "Not selected");
  }

  return rows;
}

function SummaryLine({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
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

function lotLabel(parcels: Array<{ id: number; lot_number: string | null }>, id: number) {
  const parcel = parcels.find((item) => item.id === id);
  return parcel ? `Lot ${parcel.lot_number}` : `Lot ${id}`;
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
