import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, CheckCircle2, MapPin } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useForm, type UseFormRegisterReturn, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { buildHopkinsProjectApplicationPayload } from "../../../supabase/functions/_shared/hopkins-project-application-contract.mjs";
import { buildPublicApplicationPayload } from "../../../supabase/functions/_shared/public-application-contract";
import hopkinsTierSource from "../../../map-input/hopkins.tiers.json";
import { hasHopkinsReferencePricing, resolveHopkinsReferencePrice } from "../../lib/referencePlotPricing.mjs";
import { usePublicApplicationPlots, type PublicOutlineOption, type PublicParcelOption } from "../../lib/publicApplicationPlots";
import { getPublicApplicationAccess, type PublicSiteData } from "../../lib/publicSiteExperience";
import { submitPublicFunction } from "../../lib/publicSubmission";
import { applicationIntendedUses, createApplicationSchema } from "../../lib/schemas";
import { cn, money } from "../../lib/utils";
import type { InstallmentPlan, PaymentMethod } from "../../types/database";
import { Button } from "../ui/Button";
import { Card, CardContent } from "../ui/Card";
import { Field, Input, Textarea } from "../ui/Field";
import { ErrorState, LoadingState } from "../ui/State";
import { PublicLotMap, type PublicLotParcel } from "./PublicLotMap";

type ApplicationValues = z.infer<ReturnType<typeof createApplicationSchema>>;
type ApplicationFields = UseFormReturn<ApplicationValues>;

const sections = {
  applicant: { title: "About You", goal: "Tell us who you are.", fields: ["applicant_full_name", "applicant_address", "nationality", "occupation", "phone", "email"] },
  interest: { title: "Land Interest", goal: "What are you hoping to use the land for?", fields: ["intended_use", "intended_use_other", "parcel_count"] },
  plots: { title: "Preferred Lot", goal: "Which available lot are you most interested in?", fields: ["preferred_lot_refs", "alternate_lot_preference"] },
  payment: { title: "Payment Preference", goal: "How would you like to move forward?", fields: ["payment_option", "notes"] },
  review: { title: "Review", goal: "Review and acknowledge before submitting.", fields: ["legal_notice_acknowledged", "applicant_acknowledgement_signature"] },
} as const;

type ApplicationStep = keyof typeof sections;
const stepOrder: ApplicationStep[] = ["applicant", "interest", "plots", "payment", "review"];

const emptyApplication: ApplicationValues = {
  applicant_full_name: "",
  applicant_address: "",
  nationality: "",
  occupation: "",
  phone: "",
  email: "",
  intended_use: "",
  preferred_lot_refs: [],
  sustainability_terms_verified: true,
  legal_notice_acknowledged: false,
  applicant_acknowledgement_signature: "",
};

function createSubmissionReference() {
  // The same identifier is kept on the form if a submission response is lost.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = crypto.getRandomValues(new Uint8Array(1))[0] & 0xf;
    return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function savedOutlineRefs(key: string) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? "{}") as { refs?: unknown };
    return Array.isArray(saved.refs) ? [...new Set(saved.refs.filter((ref): ref is string => typeof ref === "string"))] : [];
  } catch {
    return [];
  }
}

export function PublicApplicationForm({
  data,
  hostname,
  initialOutline,
  onClearInitialOutline,
  standalone = false,
}: {
  data: PublicSiteData;
  hostname: string;
  initialOutline?: string;
  onClearInitialOutline?: () => void;
  standalone?: boolean;
}) {
  const { scope, company, publicApplication: settings, siteExperience } = data;
  const projectApplication = siteExperience.applicationType === "project_application";
  const { map, pricing, inquiry } = siteExperience.enabledModules;
  const allowedUses = projectApplication ? settings.allowed_intended_uses ?? [] : applicationIntendedUses;
  const maxOutlines = projectApplication && map ? settings.max_map_preferences ?? 0 : 0;
  const visibleSteps = stepOrder
    .filter((step) => step !== "payment" || !projectApplication)
    .filter((step) => step !== "plots" || !projectApplication || maxOutlines > 0)
    .map((id) => ({ id, ...sections[id] }));
  const [activeStep, setActiveStep] = useState<ApplicationStep>("applicant");
  const stepIndex = visibleSteps.findIndex((step) => step.id === activeStep);
  const currentStep = visibleSteps[Math.max(0, stepIndex)];
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [plotError, setPlotError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ message: string; id?: number } | null>(null);
  const submissionReference = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const selectionKey = `wamule:hopkins-application-outlines:${hostname.toLowerCase()}:${scope.tenantSlug}:${scope.projectSlug}:${scope.phaseSlug}`;
  const showPrices = pricing && settings.show_lot_prices_publicly;
  const { accepting, canSubmit } = getPublicApplicationAccess(data, hostname);
  const selectedPhase = data.phases.find((phase) => phase.slug === scope.phaseSlug);
  const title = projectApplication ? "Project application" : "Apply for a lot";
  const Heading = standalone ? "h1" : "h2";

  const [initialRefs] = useState(() => {
    if (maxOutlines === 0) return [];
    const refs = savedOutlineRefs(selectionKey);
    return (initialOutline ? [initialOutline, ...refs.filter((ref) => ref !== initialOutline)] : refs).slice(0, maxOutlines);
  });
  const form = useForm<ApplicationValues>({
    resolver: zodResolver(createApplicationSchema(projectApplication, allowedUses)),
    defaultValues: { ...emptyApplication, preferred_lot_refs: initialRefs },
  });
  const values = form.watch();
  const selectedRefs = values.preferred_lot_refs;
  const plots = usePublicApplicationPlots(hostname, scope, canSubmit && (
    !projectApplication || selectedRefs.length > 0 || currentStep.id === "plots"
  ));
  const parcels = plots.data?.parcels ?? [];
  const outlines = plots.data?.outlines ?? [];
  const showReferencePrices = pricing && hasHopkinsReferencePricing(plots.data?.map);
  const selectedOutlines = selectedRefs.flatMap((ref) => {
    const outline = outlines.find((item) => item.ref === ref);
    if (!outline) return [];
    const price = showReferencePrices ? resolveHopkinsReferencePrice(outline.tierKey, hopkinsTierSource) : null;
    const referencePrice = price ? [price.display, price.basis].filter(Boolean).join(" · ") : "";
    return [{ ...outline, referencePrice }];
  });
  const unverifiedSelection = projectApplication && selectedRefs.length > selectedOutlines.length;
  const invalidSelection = unverifiedSelection && !plots.isFetching;

  useEffect(() => {
    if (!projectApplication || unverifiedSelection) return;
    try {
      if (selectedRefs.length > 0) window.sessionStorage.setItem(selectionKey, JSON.stringify({ refs: selectedRefs }));
      else window.sessionStorage.removeItem(selectionKey);
    } catch {
      // Preferences are kept in the form if session storage is unavailable.
    }
  }, [projectApplication, selectedRefs, selectionKey, unverifiedSelection]);

  function goToStep(step: ApplicationStep) {
    setActiveStep(step);
    sectionRef.current?.scrollIntoView({ block: "start" });
  }

  function setSelectedRefs(refs: string[]) {
    if (initialOutline && !refs.includes(initialOutline)) onClearInitialOutline?.();
    setPlotError(null);
    form.setValue("preferred_lot_refs", refs, { shouldValidate: true, shouldDirty: true });
  }

  function toggleOutline(parcel: PublicLotParcel) {
    const ref = parcel.map_feature_ref;
    if (!ref) return;
    if (selectedRefs.includes(ref)) {
      setSelectedRefs(selectedRefs.filter((selected) => selected !== ref));
    } else if (selectedRefs.length < maxOutlines) {
      setSelectedRefs([...selectedRefs, ref]);
    } else {
      setPlotError(`Choose up to ${maxOutlines} map outlines.`);
    }
  }

  async function onSubmit(input: ApplicationValues) {
    setSubmitError(null);
    if (!canSubmit) return;
    if (unverifiedSelection) {
      setPlotError("Remove any unavailable map outlines before submitting.");
      goToStep("plots");
      return;
    }
    if (!projectApplication && input.preferred_lot_refs.some((ref) => !parcels.some((lot) => lot.public_ref === ref))) {
      setPlotError("One or more lots are no longer available. Update your lot preferences before submitting.");
      goToStep("plots");
      return;
    }

    if (projectApplication && input.preferred_lot_refs.length > maxOutlines) {
      setPlotError(`Choose up to ${maxOutlines} map outlines.`);
      goToStep("plots");
      return;
    }

    const scopedInput = { ...input, tenant: scope.tenantSlug, project: scope.projectSlug, phase: scope.phaseSlug, hostname };
    try {
      if (projectApplication) {
        submissionReference.current ??= createSubmissionReference();
        const result = await submitPublicFunction<{ ok?: boolean; message?: string; application_id?: number }>(
          "submit-hopkins-project-application",
          buildHopkinsProjectApplicationPayload({
            ...scopedInput,
            submission_reference: submissionReference.current,
            preferred_map_feature_refs: input.preferred_lot_refs,
          }),
        );
        if (result?.ok !== true) throw new Error("Your application could not be confirmed. Please retry.");
        setReceipt({ message: result.message || settings.default_confirmation_message, id: result.application_id });
      } else {
        await submitPublicFunction("submit-public-application", buildPublicApplicationPayload(scopedInput));
        setReceipt({ message: settings.default_confirmation_message });
      }
      form.reset(emptyApplication);
      onClearInitialOutline?.();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "We could not submit your application. Please try again.");
    }
  }

  const selectedLots = parcels.filter((parcel) => selectedRefs.includes(parcel.public_ref));
  const selectionLabel = projectApplication ? "Selected map outlines" : "Preferred lots";
  const selectedLabels = projectApplication
    ? selectedOutlines.map(({ label, referencePrice }) =>
      referencePrice ? label + " · Reference price: " + referencePrice : label)
    : selectedLots.map((lot) => `Lot ${lot.lot_number}`);
  const selectionSummary = selectedLabels.join(", ") || "None selected";
  const notice = projectApplication
    ? "Outline preferences are for staff review and do not reserve or assign land."
    : "Submitting an application does not reserve a lot or guarantee approval.";

  return (
    <section ref={sectionRef} id="application" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-10 lg:py-12">
      <div className="mb-6 grid gap-4 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
        <div>
          <Heading className="break-words font-display text-3xl font-semibold text-primary sm:text-4xl">{title}</Heading>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {data.projectName} · {selectedPhase?.name ?? scope.phaseSlug}
          </p>
        </div>
        <div className="grid gap-2 rounded-xl border border-secondary/25 bg-[#fff8e6] p-4 text-sm text-primary shadow-sm shadow-secondary/10">
          <p className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-secondary" />Applications are reviewed by {company.company_name} staff.</p>
          <p className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0 text-secondary" />{notice}</p>
        </div>
      </div>
      {settings.public_notice_text ? (
        <div id="notice" className="mb-5 scroll-mt-20 rounded-xl border bg-card p-4 text-sm leading-6" aria-label="Application notice">
          <p className="font-semibold text-primary">Important Notice</p>
          <p className="mt-1 text-muted-foreground">{settings.public_notice_text}</p>
        </div>
      ) : null}
      {canSubmit && !receipt ? (
        <nav aria-label="Application steps" className="mb-5 overflow-x-auto rounded-xl border border-primary/15 bg-primary-soft/35 p-2 shadow-sm shadow-primary/5">
          <div className="flex min-w-max gap-2">
            {visibleSteps.map((step, index) => {
              const complete = stepIndex > index;
              const active = currentStep.id === step.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex min-h-11 min-w-[8.75rem] items-center gap-3 rounded-lg px-4 text-left text-sm font-medium transition",
                    active ? "bg-primary text-white shadow-sm shadow-primary/10" : complete ? "bg-card text-primary" : "bg-card/75 text-slate hover:bg-card hover:text-primary",
                  )}
                  disabled={form.formState.isSubmitting}
                  onClick={() => goToStep(step.id)}
                >
                  <span aria-hidden="true" className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold", active ? "bg-white text-primary" : complete ? "bg-success/10 text-success" : "bg-white text-slate")}>
                    {complete ? "✓" : index + 1}
                  </span>
                  <span className="whitespace-nowrap">{step.id === "plots" && projectApplication ? "Map Preferences" : step.title}</span>
                </button>
              );
            })}
          </div>
        </nav>
      ) : null}
      <Card className="overflow-hidden rounded-xl border-primary/15 shadow-[0_20px_60px_rgba(45,35,23,0.10)]">
        <CardContent className="p-0">
          {receipt ? (
            <div role="status" className="crm-success-panel m-5 grid justify-items-start gap-2 p-4 text-sm">
              <h3 className="font-display text-2xl font-semibold">Application received for review</h3>
              <p>{receipt.message}</p>
              {receipt.id ? <p>Application reference {receipt.id}</p> : null}
              {projectApplication ? <Button type="button" variant="outline" onClick={() => {
                submissionReference.current = null;
                setReceipt(null);
                goToStep("applicant");
              }}>Start another application</Button> : null}
            </div>
          ) : !canSubmit ? (
            <div role="status" className="crm-warning-panel m-5 p-4 text-sm">
              {accepting ? "Lot applications are available on the development’s verified website." : "Applications are currently closed."}
            </div>
          ) : (
            <form aria-label={title} noValidate onSubmit={(event) => {
              if (currentStep.id !== "review") {
                event.preventDefault();
                goToStep(visibleSteps[stepIndex + 1].id);
                return;
              }
              void form.handleSubmit(onSubmit, (errors) => {
                const firstField = Object.keys(errors)[0];
                const step = visibleSteps.find((item) => item.fields.some((field) => field === firstField));
                if (step) goToStep(step.id);
              })(event);
            }}>
              {submitError ? <div className="p-5 pb-0"><ErrorState message={submitError} /></div> : null}
              {projectApplication && currentStep.id !== "plots" && (selectedOutlines.length > 0 || unverifiedSelection) ? (
                <div className="px-5 pt-5">
                  {selectedOutlines.length > 0 ? (
                    <p role="status" aria-label="Selected map outlines" className="rounded-xl border border-primary/15 bg-primary-soft/35 p-3 text-sm font-medium text-primary">
                      Map preferences · {selectionSummary}
                    </p>
                  ) : null}
                  {unverifiedSelection ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {invalidSelection ? "A selected outline is unavailable in this phase. Review your map preferences." : "Checking your selected map outlines…"}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0 p-5 lg:p-7">
                  {currentStep.id === "applicant" ? <ApplicantFields form={form} /> : null}
                  {currentStep.id === "interest" ? <InterestFields form={form} intendedUses={allowedUses} projectApplication={projectApplication} /> : null}
                  {currentStep.id === "plots" ? (
                    <FormStep title={projectApplication ? "Map Preferences" : "Choose Your Preferred Lot"}
                      goal={projectApplication ? `Choose up to ${maxOutlines} map outlines, or continue with a general project application.` : currentStep.goal}>
                      {map ? (
                        <div className="h-[560px] overflow-hidden rounded-xl border lg:h-[640px]">
                          <PublicLotMap
                            hostname={hostname}
                            tenantSlug={scope.tenantSlug}
                            projectSlug={scope.projectSlug}
                            phaseSlug={scope.phaseSlug}
                            selectedLocalKeys={projectApplication ? undefined : selectedLots.map((lot) => lot.local_key)}
                            selectedMapFeatureRefs={projectApplication ? selectedOutlines.map((outline) => outline.ref) : undefined}
                            onToggleMapFeature={projectApplication ? toggleOutline : undefined}
                            onToggleLot={projectApplication ? undefined : (lot) => {
                              if (!lot.public_ref) return;
                              const ref = lot.public_ref;
                              setSelectedRefs(selectedRefs.includes(ref) ? selectedRefs.filter((selected) => selected !== ref) : [...selectedRefs, ref]);
                            }}
                            initialFeatureRef={initialOutline}
                            showPrices={showReferencePrices || showPrices}
                          />
                        </div>
                      ) : null}
                      {projectApplication ? (
                        <OutlinePreferences outlines={selectedOutlines}
                          onRemove={(ref) => setSelectedRefs(selectedRefs.filter((selected) => selected !== ref))} />
                      ) : (
                        <PurchasePreferences form={form} parcels={parcels} selectedRefs={selectedRefs} showPrices={showPrices}
                          loading={plots.isLoading} error={plots.error?.message}
                          onSelect={setSelectedRefs} />
                      )}
                      {invalidSelection ? (
                        <div className="grid justify-items-start gap-2 rounded-xl border p-3 text-sm">
                          <p role="status">A selected outline is unavailable in this phase.</p>
                          <Button type="button" variant="outline" onClick={() => setSelectedRefs(selectedOutlines.map((outline) => outline.ref))}>Remove unavailable selection</Button>
                        </div>
                      ) : null}
                      {plotError ? <ErrorState message={plotError} /> : null}
                    </FormStep>
                  ) : null}
                  {currentStep.id === "payment" ? (
                    <PaymentFields form={form} plans={data.installmentPlans as InstallmentPlan[]} paymentMethods={data.paymentMethods as PaymentMethod[]}
                      inquiryHref={inquiry && !standalone ? "#request-info" : undefined} />
                  ) : null}
                  {currentStep.id === "review" ? (
                    <FormStep title="Review & Acknowledge" goal={currentStep.goal}>
                      <ReviewGroup title="Applicant" onEdit={() => goToStep("applicant")} rows={[
                        ["Name", values.applicant_full_name], ["Address", values.applicant_address],
                        ["Nationality", values.nationality], ["Occupation", values.occupation],
                        ["Phone", values.phone], ["Email", values.email],
                      ]} />
                      <ReviewGroup title="Land Interest" onEdit={() => goToStep("interest")} rows={[
                        ["Intended use", values.intended_use === "Other" ? values.intended_use_other : values.intended_use],
                        ...(!projectApplication ? [["Number of parcels", values.parcel_count] as const] : []),
                      ]} />
                      {visibleSteps.some((step) => step.id === "plots") ? (
                        <ReviewGroup title={projectApplication ? "Map Preferences" : "Lot Preference"} onEdit={() => goToStep("plots")} rows={[
                          [selectionLabel, selectionSummary],
                          ...(!projectApplication ? [["Alternative lot", values.alternate_lot_preference] as const] : []),
                        ]} />
                      ) : null}
                      {!projectApplication ? <ReviewGroup title="Payment Preference" onEdit={() => goToStep("payment")} rows={[
                        ["Plan", values.payment_option],
                        ...(values.notes ? [["Notes", values.notes] as const] : []),
                      ]} /> : null}
                      {projectApplication ? <Field label="Additional notes (optional)"><Textarea {...form.register("notes")} maxLength={2000} /></Field> : null}
                      <label className="flex gap-3 rounded-xl border border-success/20 bg-success/10 p-4 text-sm">
                        <input type="checkbox" className="mt-1" {...form.register("legal_notice_acknowledged")} />
                        <span>I have read and acknowledge the project notice and application terms.
                          {form.formState.errors.legal_notice_acknowledged ? (
                            <span className="mt-1 block text-danger">{form.formState.errors.legal_notice_acknowledged.message}</span>
                          ) : null}
                        </span>
                      </label>
                      <div className="rounded-xl border bg-card p-4 text-sm leading-6">
                        <p className="font-semibold text-primary">Applicant Acknowledgement</p>
                        <p className="mt-2 text-muted-foreground">{settings.application_acknowledgment_text}</p>
                        <div className="mt-4">
                          <Field label="Type your full name as acknowledgement" error={form.formState.errors.applicant_acknowledgement_signature?.message}>
                            <Input {...form.register("applicant_acknowledgement_signature")} autoComplete="name" maxLength={160} />
                          </Field>
                        </div>
                      </div>
                    </FormStep>
                  ) : null}
                </div>
                <aside className="hidden border-primary/10 bg-primary/95 p-5 text-white lg:block lg:border-l lg:p-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/65">Application Summary</p>
                  <div className="mt-5 grid gap-2 text-sm">
                    <SummaryLine label="Step" value={`${stepIndex + 1} of ${visibleSteps.length}`} />
                    <SummaryLine label="Applicant" value={values.applicant_full_name || "Not entered"} />
                    {values.intended_use ? <SummaryLine label="Intended use" value={values.intended_use === "Other" ? values.intended_use_other || "Other" : values.intended_use} /> : null}
                    {selectedLabels.length > 0 ? <SummaryLine label={selectionLabel} value={selectionSummary} /> : null}
                    {values.payment_option ? <SummaryLine label="Payment plan" value={values.payment_option} /> : null}
                  </div>
                </aside>
              </div>
              <div className="flex flex-col-reverse gap-3 border-t border-border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
                <Button type="button" variant="outline" disabled={stepIndex <= 0 || form.formState.isSubmitting} onClick={() => goToStep(visibleSteps[stepIndex - 1].id)}>
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                {currentStep.id === "review" ? (
                  <Button type="submit" disabled={form.formState.isSubmitting}>
                    {form.formState.isSubmitting ? "Submitting…" : projectApplication ? "Submit project application" : "Submit application"}
                  </Button>
                ) : (
                  <Button type="button" onClick={() => goToStep(visibleSteps[stepIndex + 1].id)}>
                    Continue <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ApplicantFields({ form }: { form: ApplicationFields }) {
  const { register, formState: { errors } } = form;
  return (
    <FormStep title="About You" goal={sections.applicant.goal}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Applicant Full Name" error={errors.applicant_full_name?.message}>
          <Input {...register("applicant_full_name")} autoComplete="name" maxLength={160} />
        </Field>
        <Field label="Applicant Address" error={errors.applicant_address?.message}>
          <Input {...register("applicant_address")} autoComplete="street-address" maxLength={500} />
        </Field>
        <Field label="Nationality" error={errors.nationality?.message}>
          <Input {...register("nationality")} autoComplete="country-name" maxLength={100} />
        </Field>
        <Field label="Occupation" error={errors.occupation?.message}>
          <Input {...register("occupation")} autoComplete="organization-title" maxLength={160} />
        </Field>
        <Field label="Telephone Contact" error={errors.phone?.message}>
          <Input {...register("phone")} type="tel" autoComplete="tel" maxLength={40} />
        </Field>
        <Field label="Email Address" error={errors.email?.message}>
          <Input {...register("email")} type="email" autoComplete="email" maxLength={254} />
        </Field>
      </div>
    </FormStep>
  );
}

function InterestFields({ form, intendedUses, projectApplication }: {
  form: ApplicationFields;
  intendedUses: readonly string[];
  projectApplication: boolean;
}) {
  const { register, formState: { errors } } = form;
  const intendedUse = form.watch("intended_use");
  return (
    <FormStep title="Your Land Interest" goal={sections.interest.goal}>
      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium">The land is intended for</legend>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {intendedUses.map((option) => (
            <ChoiceCard key={option} selected={intendedUse === option}>
              <input type="radio" value={option} {...register("intended_use")} />
              <span>{option}</span>
            </ChoiceCard>
          ))}
        </div>
        {errors.intended_use ? <p className="text-sm text-danger">{errors.intended_use.message}</p> : null}
      </fieldset>
      {intendedUse === "Other" ? (
        <Field label="Other intended use" error={errors.intended_use_other?.message}>
          <Input {...register("intended_use_other")} maxLength={500} />
        </Field>
      ) : null}
      {!projectApplication ? (
        <Field label="Number of parcels interested in purchasing" error={errors.parcel_count?.message}>
          <Input type="number" min="1" {...register("parcel_count")} />
        </Field>
      ) : null}
    </FormStep>
  );
}

function PurchasePreferences({ form, parcels, selectedRefs, showPrices, loading, error, onSelect }: {
  form: ApplicationFields;
  parcels: PublicParcelOption[];
  selectedRefs: string[];
  showPrices: boolean;
  loading: boolean;
  error?: string;
  onSelect: (refs: string[]) => void;
}) {
  return (
    <>
      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium">Preferred lots</legend>
        {loading ? <LoadingState label="Loading available lots" /> : null}
        {error ? <ErrorState message={error} /> : null}
        {!loading && !error && parcels.length === 0 ? <p className="text-sm text-muted-foreground">No available lots are currently listed.</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {parcels.map((parcel) => {
            const selected = selectedRefs.includes(parcel.public_ref);
            return (
              <label key={parcel.public_ref} className={cn(
                "relative cursor-pointer rounded-xl border p-4 text-sm transition",
                selected ? "border-primary bg-primary-soft ring-1 ring-primary" : "border-border bg-card hover:border-primary/40",
              )}>
                <input className="sr-only" type="checkbox" checked={selected}
                  onChange={() => onSelect(selected ? selectedRefs.filter((ref) => ref !== parcel.public_ref) : [...selectedRefs, parcel.public_ref])} />
                <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-secondary">Lot</span>
                <span className="mt-1 block text-2xl font-semibold text-primary">{parcel.lot_number}</span>
                <span className="mt-2 block text-sm text-muted-foreground">{parcel.dimensions}</span>
                {showPrices ? <span className="mt-3 block font-semibold text-primary">{money(parcel.base_price)}</span> : null}
                <span className={cn("absolute right-3 top-3 rounded-full px-2 py-1 text-xs font-semibold", selected ? "bg-primary text-white" : "bg-success/10 text-success")}>
                  {selected ? "Selected" : parcel.status}
                </span>
              </label>
            );
          })}
        </div>
        {form.formState.errors.preferred_lot_refs ? <p className="text-sm text-danger">{form.formState.errors.preferred_lot_refs.message}</p> : null}
      </fieldset>
      <div className="rounded-xl border border-primary/15 bg-primary-soft/35 p-4">
        <Field label="Alternative lot option if your first preference is unavailable" error={form.formState.errors.alternate_lot_preference?.message}>
          <Input {...form.register("alternate_lot_preference")} maxLength={240} />
        </Field>
      </div>
    </>
  );
}

function OutlinePreferences({ outlines, onRemove }: {
  outlines: Array<PublicOutlineOption & { referencePrice: string }>;
  onRemove: (ref: string) => void;
}) {
  return (
    <fieldset className="grid gap-3 rounded-xl border border-primary/15 bg-primary-soft/35 p-4">
      <legend className="px-1 text-sm font-semibold text-primary">Selected map outlines</legend>
      {outlines.length === 0 ? <p className="text-sm text-muted-foreground">No outline preference selected.</p> : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {outlines.map((outline) => (
            <li key={outline.ref} className="flex items-start justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <div>
                <p className="font-semibold">{outline.label}</p>
                {outline.verifiedPrintedNumber ? <p className="text-xs">Verified printed plan number: {outline.verifiedPrintedNumber}</p> : null}
                {outline.referencePrice ? <p className="text-xs">Reference price: {outline.referencePrice}</p> : null}
              </div>
              <Button type="button" variant="ghost" className="shrink-0" aria-label={`Remove ${outline.label}`} onClick={() => onRemove(outline.ref)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function PaymentFields({ form, plans, paymentMethods, inquiryHref }: {
  form: ApplicationFields;
  plans: InstallmentPlan[];
  paymentMethods: PaymentMethod[];
  inquiryHref?: string;
}) {
  return (
    <FormStep title="Payment Preference" goal={sections.payment.goal}>
      <fieldset className="grid gap-3">
        <legend className="font-semibold text-primary">Payment plan</legend>
        <p className="text-sm text-muted-foreground">Choose the plan you prefer for review. No payment is collected here.</p>
        <div className="grid gap-3 lg:grid-cols-2">
          {plans.map((plan) => <PaymentChoice key={plan.id} plan={plan} selected={form.watch("payment_option") === plan.name} register={form.register("payment_option")} />)}
        </div>
        {form.formState.errors.payment_option ? <p className="text-sm text-danger">{form.formState.errors.payment_option.message}</p> : null}
      </fieldset>
      {paymentMethods.length > 0 ? (
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold text-primary">How payments can be made</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {paymentMethods.map((method) => <PaymentMethodCard key={method.id} method={method} />)}
          </div>
        </div>
      ) : null}
      {inquiryHref ? <a className="text-sm font-semibold text-primary underline" href={inquiryHref}>Request project information</a> : null}
      <Field label="Additional notes"><Textarea {...form.register("notes")} maxLength={2000} /></Field>
    </FormStep>
  );
}

function ReviewGroup({ title, rows, onEdit }: {
  title: string;
  rows: ReadonlyArray<readonly [string, string | number | undefined]>;
  onEdit: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm shadow-primary/5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-primary">{title}</p>
        <Button type="button" variant="ghost" className="h-8 px-3 text-xs" aria-label={`Edit ${title}`} onClick={onEdit}>Edit</Button>
      </div>
      <div className="mt-3 grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-b border-border/70 pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[140px_minmax(0,1fr)]">
            <span className="text-muted-foreground">{label}</span>
            <span className="break-words font-medium text-foreground">{value || "Not entered"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/15 pb-3 last:border-b-0 last:pb-0">
      <span className="text-white/60">{label}</span>
      <span className="max-w-[12rem] break-words text-right font-semibold">{value}</span>
    </div>
  );
}

function FormStep({ title, goal, children }: { title: string; goal: string; children: ReactNode }) {
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

function ChoiceCard({ selected, children }: { selected: boolean; children: ReactNode }) {
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
  register: UseFormRegisterReturn;
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
