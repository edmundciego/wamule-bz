import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, MapPin, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useLocation } from "react-router-dom";
import type { z } from "zod";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Field, Input, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { applicationSchema } from "../lib/schemas";
import { hasSupabaseConfig, supabase } from "../lib/supabase";
import { cn, money } from "../lib/utils";
import type { BusinessSetting, InstallmentPlan } from "../types/database";

type ApplicationValues = z.infer<typeof applicationSchema>;

const intendedUseOptions = [
  "Residential",
  "Commercial",
  "Agriculture",
  "Investment",
  "Rental Property",
  "Other",
] as const;

const defaultCompany = {
  company_name: "Wamuale Development",
  logo_url: "/favicon/android-chrome-192x192.png",
  contact_email: "",
  phone_number: "",
  website: "",
  location_address: "Mile 3 on the Hummingbird Highway in Dangriga Town, Belize",
  short_description: "Private subdivision land development in Dangriga Town, Belize.",
};

const defaultApplicationSettings = {
  applications_open: true,
  public_notice_text:
    "Submission of this application is solely a request to be considered for the purchase of a lot within Wamuale Development. Submission or acceptance of this application does not create any legal right to purchase land, does not reserve a lot, and does not guarantee that any lot will be sold or transferred to the applicant.",
  application_acknowledgment_text:
    "By signing this application, I acknowledge and understand that submission does not guarantee approval or allocation of a lot; approval is subject to availability and acceptance by Wamuale Development; the reservation fee is non-refundable and paid to reserve a selected lot; final selection is subject to inspection and confirmation; only a signed purchase agreement may result in ownership transfer; utilities and closing charges may be applicant responsibilities; and this application is not a sale agreement.",
  show_lot_prices_publicly: true,
  show_available_lot_count_publicly: true,
  default_confirmation_message: "Application submitted. A Wamuale Development representative will contact you after review.",
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
  const { data: publicSettings } = useQuery({
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
        "Applicant acknowledged the Wamuale Development application notice, reservation terms, and applicant acknowledgement.",
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

  const company = { ...defaultCompany, ...settingValue<typeof defaultCompany>(publicSettings, "company_profile") };
  const applicationSettings = {
    ...defaultApplicationSettings,
    ...settingValue<typeof defaultApplicationSettings>(publicSettings, "public_application"),
  };
  const lotPhase = { ...defaultLotPhase, ...settingValue<typeof defaultLotPhase>(publicSettings, "lot_phase") };
  const availableLots = parcels?.length ?? 0;
  const visiblePlans = installmentPlans?.length ? installmentPlans : fallbackApplicationPlans();

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-primary/10 bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <a href="/" className="flex items-center gap-3">
            <img
              src={company.logo_url || "/favicon/android-chrome-192x192.png"}
              alt={company.company_name}
              className="h-12 w-12 rounded-md border border-copper/30 bg-ivory object-cover shadow-sm"
            />
            <div>
              <p className="font-display text-xl font-semibold leading-tight text-primary">{company.company_name.replace(/\s+Development$/i, "")}</p>
              <p className="text-xs font-semibold uppercase tracking-[0.26em] text-copper">Development</p>
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
              className="inline-flex h-10 items-center gap-2 rounded-md bg-copper px-4 text-sm font-medium text-white shadow-sm hover:bg-copper/90"
              href="#application"
            >
              Apply <ArrowRight className="h-4 w-4" />
            </a>
          </nav>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-14">
        <div>
          <Badge tone={applicationSettings.applications_open ? "green" : "amber"}>
            {lotPhase.phase_name} applications {applicationSettings.applications_open ? "open" : "closed"}
          </Badge>
          <h1 className="mt-5 max-w-3xl font-display text-5xl font-semibold tracking-normal text-primary sm:text-6xl">
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
            <a className="inline-flex h-11 items-center gap-2 rounded-md bg-copper px-5 text-sm font-medium text-white shadow-sm hover:bg-copper/90" href="#application">
              Start application <ArrowRight className="h-4 w-4" />
            </a>
            <a className="inline-flex h-11 items-center rounded-md border bg-card px-5 text-sm font-medium text-primary hover:bg-muted/60" href="#notice">
              Read important notice
            </a>
          </div>
        </div>

        <div id="lots" className="overflow-hidden rounded-lg border bg-card shadow-sm shadow-primary/5">
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
              <div className="rounded-md border border-dashed bg-ivory/40 p-5 text-sm text-muted-foreground">
                Lot availability is confirmed by Wamuale Development staff during application review.
              </div>
            ) : isLoading ? (
              <LoadingState label="Loading lot availability" />
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {parcels?.slice(0, 24).map((parcel) => (
                  <div key={parcel.id} className="aspect-[1.25] rounded-md border border-sage/30 bg-sage/10 p-2 text-xs">
                    <strong className="block">Lot {parcel.lot_number}</strong>
                    {applicationSettings.show_lot_prices_publicly ? <span className="mt-1 block text-copper">{money(parcel.base_price)}</span> : null}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              Preference selections do not reserve a lot. Staff will confirm availability and terms after review.
            </p>
          </div>
        </div>
      </section>

      <section className="border-y border-primary/10 bg-card" id="notice">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[280px_1fr]">
          <div>
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-md bg-copper/10">
              <ShieldCheck className="h-5 w-5 text-copper" />
            </div>
            <h2 className="brand-rule font-display text-2xl font-semibold text-primary">Important Notice</h2>
            <p className="mt-2 text-sm text-muted-foreground">Owner/Developer: {company.company_name}</p>
          </div>
          <div className="grid gap-4 text-sm leading-6 text-muted-foreground">
            <p>{applicationSettings.public_notice_text}</p>
            {company.location_address ? <p>Location: {company.location_address}</p> : null}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 lg:py-12" id="application">
        <div className="mb-6 grid gap-4 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-copper">Application</p>
            <h2 className="mt-2 font-display text-4xl font-semibold tracking-normal text-primary">Request consideration for a lot</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Complete the form below. A representative will contact you after review.
            </p>
          </div>
          <div className="grid gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground shadow-sm shadow-primary/5">
            <p className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-copper" />Applications are reviewed by Wamuale Development staff.</p>
            <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-copper" />Preferred lots are requests only and do not reserve land.</p>
          </div>
        </div>

        <Card>
          <CardContent className="p-5 lg:p-6">
            {!hasSupabaseConfig ? <ErrorState message="Supabase environment variables are missing." /> : null}
            {submitted ? (
              <div className="rounded-md border border-sage/35 bg-sage/15 p-4 text-sm text-primary">
                {applicationSettings.default_confirmation_message}
              </div>
            ) : !applicationSettings.applications_open ? (
              <div className="rounded-md border border-copper/30 bg-copper/10 p-4 text-sm text-copper">
                Applications are currently closed. {applicationSettings.public_notice_text}
              </div>
            ) : (
              <form className="grid gap-7" onSubmit={form.handleSubmit(onSubmit)}>
                {submitError ? <ErrorState message={submitError} /> : null}
                <FormSection title="Applicant Details">
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
                </FormSection>

                <FormSection title="Intended Use">
                  <Field label="The lot is intended for" error={form.formState.errors.intended_use?.message}>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {intendedUseOptions.map((option) => (
                        <label key={option} className="flex items-center gap-2 rounded-md border bg-white p-3 text-sm font-normal shadow-sm shadow-primary/5">
                          <input type="radio" value={option} {...form.register("intended_use")} />
                          {option}
                        </label>
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
                </FormSection>

                <FormSection title="Lot Preferences">
                  <Field label="Preferred lots" error={form.formState.errors.preferred_parcel_ids?.message}>
                    {isLoading ? (
                      <LoadingState label="Loading available lots" />
                    ) : (
                      <div className="grid gap-3">
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                          {parcels?.map((parcel) => {
                            const selected = selectedLotIds.map(Number).includes(parcel.id);
                            return (
                              <label
                                key={parcel.id}
                                className={cn(
                                  "cursor-pointer rounded-md border p-3 text-sm font-normal transition",
                                  selected ? "border-copper bg-copper/10 ring-1 ring-copper" : "bg-white hover:border-copper/50",
                                )}
                              >
                                <input className="sr-only" type="checkbox" value={parcel.id} {...form.register("preferred_parcel_ids")} />
                                <span className="block font-semibold">Lot {parcel.lot_number}</span>
                                <span className="block text-xs text-muted-foreground">{parcel.dimensions}</span>
                                {applicationSettings.show_lot_prices_publicly ? <span className="mt-2 block text-xs">{money(parcel.base_price)}</span> : null}
                              </label>
                            );
                          })}
                        </div>
                        {parcels?.length === 0 ? <p className="text-sm text-muted-foreground">No available lots are currently listed.</p> : null}
                      </div>
                    )}
                  </Field>
                  <Field label="Alternative lot option if your first preference is unavailable" error={form.formState.errors.alternate_lot_preference?.message}>
                    <Input {...form.register("alternate_lot_preference")} />
                  </Field>
                </FormSection>

                <FormSection title="Payment Option">
                  <Field label="Select one" error={form.formState.errors.payment_option?.message}>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {visiblePlans.map((plan) => (
                        <PaymentChoice key={plan.id} plan={plan} register={form.register("payment_option")} />
                      ))}
                    </div>
                  </Field>
                  <Field label="Additional notes">
                    <Textarea {...form.register("notes")} />
                  </Field>
                </FormSection>

                <FormSection title="Acknowledgements">
                  <label className="flex gap-3 rounded-md border bg-sage/10 p-3 text-sm">
                    <input type="checkbox" className="mt-1" {...form.register("legal_notice_acknowledged")} />
                    <span>
                      I acknowledge that submission of this application does not guarantee approval, reserve a lot, or create any legal right to purchase land.
                      {form.formState.errors.legal_notice_acknowledged ? (
                        <span className="mt-1 block text-red-700">{form.formState.errors.legal_notice_acknowledged.message}</span>
                      ) : null}
                    </span>
                  </label>
                  <div className="rounded-md border bg-white p-4 text-sm leading-6 shadow-sm shadow-primary/5">
                    <p className="font-semibold">Applicant Acknowledgement</p>
                    <p className="mt-2 text-muted-foreground">
                      {applicationSettings.application_acknowledgment_text}
                    </p>
                    <div className="mt-4">
                      <Field label="Type your full name as acknowledgement" error={form.formState.errors.applicant_acknowledgement_signature?.message}>
                        <Input {...form.register("applicant_acknowledgement_signature")} />
                      </Field>
                    </div>
                  </div>
                </FormSection>

                <div className="flex justify-end">
                  <Button disabled={form.formState.isSubmitting}>Submit application</Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm shadow-primary/5">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-copper">{label}</p>
      <p className="mt-1 font-display text-xl font-semibold text-primary">{value}</p>
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b pb-7 last:border-b-0 last:pb-0">
      <h3 className="font-display text-xl font-semibold text-primary">{title}</h3>
      <div className="grid gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

function PaymentChoice({
  plan,
  register,
}: {
  plan: InstallmentPlan;
  register: ReturnType<typeof useForm<ApplicationValues>>["register"] extends (...args: never[]) => infer R ? R : never;
}) {
  const details = [
    plan.description,
    `Reservation fee: ${money(Number(plan.reservation_fee))}`,
    Number(plan.monthly_payment) > 0 ? `${money(Number(plan.monthly_payment))} - ${plan.term_months} months` : `Purchase price: ${money(Number(plan.final_purchase_price))}`,
  ].filter(Boolean);

  return (
    <label className="grid gap-2 rounded-md border bg-white p-4 text-sm font-normal shadow-sm shadow-primary/5">
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
