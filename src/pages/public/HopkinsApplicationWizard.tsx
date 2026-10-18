import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, MapPin, Send } from "lucide-react";
import { ChoiceCard, FormStep, SummaryLine } from "../ApplicationPage";
import { PublicLotMap, type PublicLotParcel } from "../../components/public/PublicLotMap";
import { Button } from "../../components/ui/Button";
import { Card, CardContent } from "../../components/ui/Card";
import { Field, Input, Textarea } from "../../components/ui/Field";
import { ErrorState } from "../../components/ui/State";
import { submitPublicFunction } from "../../lib/publicSubmission";
import { isLocalOnlySubmission } from "../../lib/publicSubmissionMode";
import { readPublicWizardStep, writePublicWizardStep } from "../../lib/publicDraftState.mjs";
import { cn } from "../../lib/utils";
import type { PublicSiteModuleId } from "../../lib/publicExperience.mjs";
import { buildHopkinsProjectApplicationPayload } from "../../../supabase/functions/_shared/hopkins-project-application-contract.mjs";

const HOPKINS_SCOPE = { tenant: "hopkins-grove", project: "hopkins-grove", phase: "initial" } as const;
const HOPKINS_DRAFT_SCOPE = { tenantSlug: HOPKINS_SCOPE.tenant, projectSlug: HOPKINS_SCOPE.project, phaseSlug: HOPKINS_SCOPE.phase } as const;
const SUPPORTED_PROJECT_USES = ["Residential", "Commercial", "Agriculture", "Investment", "Rental Property", "Other"] as const;

const applicationSteps = [
  { id: 0, label: "About You", goal: "Tell us who you are." },
  { id: 1, label: "Project Interest", goal: "Tell the Hopkins team what you are considering." },
  { id: 2, label: "Map Preferences", goal: "Choose optional outline references for staff review." },
  { id: 3, label: "Additional Details", goal: "Share any other information for the project team." },
  { id: 4, label: "Review", goal: "Review and acknowledge before submitting." },
] as const;

type HopkinsApplicationSettings = {
  applicationsOpen: boolean;
  noticeVersion: string;
  publicNotice: string;
  acknowledgmentText: string;
  intendedUses: string[];
  maxMapPreferences: number;
  confirmationMessage: string;
};

type ApplicantDraft = {
  name: string;
  address: string;
  nationality: string;
  occupation: string;
  phone: string;
  email: string;
  intendedUse: string;
  otherUse: string;
  notes: string;
  signature: string;
  acknowledged: boolean;
};

type ApplicantErrorKey = keyof ApplicantDraft;
type HopkinsApplicationWizardProps = {
  projectName: string;
  applicationSettings: HopkinsApplicationSettings;
  modules: Record<PublicSiteModuleId, boolean>;
  selectedMapFeatureRefs: string[];
  mapFeatureLabels: Array<{ ref: string; label: string }>;
  mapPreferenceError: string | null;
  onToggleMapFeature: (parcel: PublicLotParcel) => void;
  onParcelsLoaded: (features: PublicLotParcel[]) => void;
  onRemoveMapFeature: (ref: string) => void;
  localDemoOnly?: boolean;
};

function createSubmissionReference(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Use a UUID-shaped fallback for older browsers.
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

const emptyDraft = (): ApplicantDraft => ({
  name: "",
  address: "",
  nationality: "",
  occupation: "",
  phone: "",
  email: "",
  intendedUse: "",
  otherUse: "",
  notes: "",
  signature: "",
  acknowledged: false,
});

export function HopkinsApplicationWizard({
  projectName,
  applicationSettings,
  modules,
  selectedMapFeatureRefs,
  mapFeatureLabels,
  mapPreferenceError,
  onToggleMapFeature,
  onParcelsLoaded,
  onRemoveMapFeature,
  localDemoOnly = isLocalOnlySubmission,
}: HopkinsApplicationWizardProps) {
  const [draft, setDraft] = useState<ApplicantDraft>(emptyDraft);
  const [activeStep, setActiveStep] = useState(() => typeof window === "undefined" ? 0 : readPublicWizardStep(window.localStorage, HOPKINS_DRAFT_SCOPE, applicationSteps.length));
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [mapDataLoaded, setMapDataLoaded] = useState(false);
  const [mapLoadError, setMapLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ApplicantErrorKey, string>>>({});
  const [submissionReference, setSubmissionReference] = useState(createSubmissionReference);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ message: string; id?: number } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    writePublicWizardStep(window.localStorage, HOPKINS_DRAFT_SCOPE, activeStep, applicationSteps.length);
  }, [activeStep]);
  const configuredUses = applicationSettings.intendedUses.filter((use) => SUPPORTED_PROJECT_USES.includes(use as typeof SUPPORTED_PROJECT_USES[number]));
  const intendedUses = configuredUses.length ? configuredUses : [...SUPPORTED_PROJECT_USES];
  const configuredMapLimit = Number(applicationSettings.maxMapPreferences);
  const maxMapPreferences = Number.isFinite(configuredMapLimit) && configuredMapLimit >= 0
    ? Math.min(20, configuredMapLimit)
    : 5;

  function updateDraft(field: ApplicantErrorKey, value: string | boolean) {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setSubmitError(null);
    const fieldStep = ["name", "address", "nationality", "occupation", "phone", "email"].includes(field)
      ? 0
      : ["intendedUse", "otherUse"].includes(field) ? 1
        : field === "notes" ? 3 : 4;
    setCompletedSteps((current) => current.filter((step) => step !== fieldStep));
  }

  function validateStep(step: number): Partial<Record<ApplicantErrorKey, string>> {
    const errors: Partial<Record<ApplicantErrorKey, string>> = {};
    if (step === 0 || step === -1) {
      if (draft.name.trim().length < 2) errors.name = "Enter your full legal name.";
      if (!draft.address.trim()) errors.address = "Enter your mailing address.";
      if (!draft.nationality.trim()) errors.nationality = "Enter your nationality.";
      if (!draft.occupation.trim()) errors.occupation = "Enter your occupation.";
      if (draft.phone.replace(/\D/g, "").length < 7) errors.phone = "Enter a valid phone number.";
      if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(draft.email.trim())) errors.email = "Enter a valid email address.";
    }
    if (step === 1 || step === -1) {
      if (!intendedUses.includes(draft.intendedUse)) errors.intendedUse = "Choose an intended project use.";
      if (draft.intendedUse === "Other" && !draft.otherUse.trim()) errors.otherUse = "Describe your intended project use.";
    }
    if (step === 4 || step === -1) {
      if (!draft.acknowledged) errors.acknowledged = "Acknowledge the Hopkins project notice before submitting.";
      if (draft.signature.trim().toLowerCase() !== draft.name.trim().toLowerCase()) errors.signature = "Type your full name to sign.";
    }
    return errors;
  }

  function continueToNextStep() {
    const errors = validateStep(activeStep);
    setFieldErrors((current) => ({ ...current, ...errors }));
    if (Object.keys(errors).length > 0) return;
    if (activeStep === 2 && modules.map && !mapDataLoaded) {
      setMapLoadError("The project map has not loaded yet. Keep this step open and try again.");
      return;
    }
    setCompletedSteps((current) => current.includes(activeStep) ? current : [...current, activeStep]);
    setActiveStep((step) => Math.min(step + 1, applicationSteps.length - 1));
  }

  function stepIsComplete(step: number): boolean {
    if (step === 4) return Boolean(receipt);
    if (!completedSteps.includes(step)) return false;
    if ((step === 0 || step === 1) && Object.keys(validateStep(step)).length > 0) return false;
    if (step === 2 && modules.map && !mapDataLoaded) return false;
    return true;
  }

  function handleMapParcelsLoaded(features: PublicLotParcel[]) {
    setMapDataLoaded(true);
    setMapLoadError(null);
    onParcelsLoaded(features);
  }

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const errors = validateStep(-1);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const firstInvalidStep = Object.keys(errors).some((key) => ["name", "address", "nationality", "occupation", "phone", "email"].includes(key))
        ? 0
        : Object.keys(errors).some((key) => ["intendedUse", "otherUse"].includes(key)) ? 1 : 4;
      setActiveStep(firstInvalidStep);
      return;
    }
    if (!applicationSettings.applicationsOpen) {
      setSubmitError("Applications are currently closed.");
      return;
    }

    setSubmitting(true);
    try {
      if (localDemoOnly) {
        setReceipt({ message: "Local preview complete. No application was saved or sent." });
        setCompletedSteps((current) => current.includes(4) ? current : [...current, 4]);
        return;
      }
      const data = await submitPublicFunction<{ ok?: boolean; message?: string; application_id?: number }>("submit-hopkins-project-application", buildHopkinsProjectApplicationPayload({
        submission_reference: submissionReference,
        applicant_full_name: draft.name,
        applicant_address: draft.address,
        nationality: draft.nationality,
        occupation: draft.occupation,
        phone: draft.phone,
        email: draft.email,
        intended_use: draft.intendedUse,
        intended_use_other: draft.otherUse,
        preferred_map_feature_refs: selectedMapFeatureRefs,
        notes: draft.notes,
        legal_notice_acknowledged: draft.acknowledged,
        applicant_acknowledgement_signature: draft.signature,
      }));
      if (data?.ok !== true) throw new Error("Your application could not be confirmed. Please retry.");
      setReceipt({ message: String(data.message || applicationSettings.confirmationMessage), id: Number(data.application_id) || undefined });
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : "Your application could not be sent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetApplication() {
    setDraft(emptyDraft());
    setActiveStep(0);
    setFieldErrors({});
    setCompletedSteps([]);
    setMapDataLoaded(false);
    setSubmissionReference(createSubmissionReference());
    setReceipt(null);
    setSubmitError(null);
    selectedMapFeatureRefs.forEach(onRemoveMapFeature);
  }

  const summaryRows = [
    { label: "Applicant", value: draft.name || "Not entered", muted: !draft.name },
    { label: "Project use", value: draft.intendedUse || "Not selected", muted: !draft.intendedUse },
    { label: "Map references", value: selectedMapFeatureRefs.length ? String(selectedMapFeatureRefs.length) : "None", muted: !selectedMapFeatureRefs.length },
  ];
  const visibleMapLabels = selectedMapFeatureRefs.map((ref) => ({
    ref,
    label: mapFeatureLabels.find((feature) => feature.ref === ref)?.label ?? `Map outline ${ref.slice(0, 8)}`,
  }));

  return (
    <section id="application" className="scroll-mt-20 mx-auto max-w-6xl px-4 py-10 lg:py-12">
      <div className="mb-6 grid gap-4 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-secondary">Application</p>
          <h2 className="mt-2 break-words font-display text-3xl font-semibold tracking-normal text-primary sm:text-4xl">Apply for {projectName}</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Share your details and project interests for staff review. Map outlines are optional references only; this application does not allocate a lot.
          </p>
        </div>
        <div className="grid gap-2 rounded-xl border border-secondary/25 bg-[#fff8e6] p-4 text-sm text-primary shadow-sm shadow-secondary/10">
          <p className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-secondary" />Applications are reviewed by Hopkins Grove staff.</p>
          <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-secondary" />Map references are preferences, not parcels or assignments.</p>
        </div>
      </div>

      <div className="mb-5 overflow-x-auto rounded-xl border border-primary/15 bg-primary-soft/35 p-2 shadow-sm shadow-primary/5">
        <div className="flex min-w-max gap-2">
          {applicationSteps.map((step) => {
            const complete = stepIsComplete(step.id);
            const active = activeStep === step.id;
            return (
              <button
                key={step.id}
                type="button"
                aria-pressed={active}
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
          {!applicationSettings.applicationsOpen ? (
            <div className="crm-warning-panel m-5 p-4 text-sm">Applications are currently closed. {applicationSettings.publicNotice}</div>
          ) : receipt ? (
            <div role="status" className="crm-success-panel m-5 p-4 text-sm">
              <p className="font-semibold">Application received for review</p>
              <p className="mt-2">{receipt.message} No parcel or outline has been assigned.</p>
              {receipt.id ? <p className="mt-2 text-xs">Application reference {receipt.id}</p> : null}
              <Button type="button" variant="outline" className="mt-4" onClick={resetApplication}>Start another application</Button>
            </div>
          ) : (
            <form onSubmit={(event) => void submitApplication(event)}>
              {submitError ? <div className="p-5 pb-0"><ErrorState message={submitError} /></div> : null}
              <div className={cn("grid gap-0", activeStep === 2 ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_320px]")}>
                <div className="min-w-0 p-4 sm:p-5 lg:p-7">
                  {activeStep === 0 ? (
                    <FormStep title="About You" goal={applicationSteps[0].goal}>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Field label="Applicant Full Name" error={fieldErrors.name}><Input name="applicant_full_name" autoComplete="name" maxLength={160} required value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></Field>
                        <Field label="Applicant Address" error={fieldErrors.address}><Input name="applicant_address" autoComplete="street-address" maxLength={500} required value={draft.address} onChange={(event) => updateDraft("address", event.target.value)} /></Field>
                        <Field label="Nationality" error={fieldErrors.nationality}><Input name="nationality" autoComplete="country-name" maxLength={100} required value={draft.nationality} onChange={(event) => updateDraft("nationality", event.target.value)} /></Field>
                        <Field label="Occupation" error={fieldErrors.occupation}><Input name="occupation" autoComplete="organization-title" maxLength={160} required value={draft.occupation} onChange={(event) => updateDraft("occupation", event.target.value)} /></Field>
                        <Field label="Telephone Contact" error={fieldErrors.phone}><Input name="phone" type="tel" autoComplete="tel" maxLength={40} required value={draft.phone} onChange={(event) => updateDraft("phone", event.target.value)} /></Field>
                        <Field label="Email Address" error={fieldErrors.email}><Input name="email" type="email" autoComplete="email" maxLength={254} required value={draft.email} onChange={(event) => updateDraft("email", event.target.value)} /></Field>
                      </div>
                    </FormStep>
                  ) : null}

                  {activeStep === 1 ? (
                    <FormStep title="Your Project Interest" goal={applicationSteps[1].goal}>
                      <Field label="The project is intended for" error={fieldErrors.intendedUse}>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {intendedUses.map((use) => (
                            <ChoiceCard key={use} selected={draft.intendedUse === use}>
                              <input type="radio" name="intended_use" value={use} checked={draft.intendedUse === use} onChange={() => updateDraft("intendedUse", use)} />
                              <span>{use}</span>
                            </ChoiceCard>
                          ))}
                        </div>
                      </Field>
                      {draft.intendedUse === "Other" ? <Field label="Other intended use" error={fieldErrors.otherUse}><Input name="intended_use_other" maxLength={500} required value={draft.otherUse} onChange={(event) => updateDraft("otherUse", event.target.value)} /></Field> : null}
                      <div className="rounded-xl border border-primary/15 bg-primary-soft/35 p-4 text-sm leading-6 text-muted-foreground">
                        This form records general project interest. Published map outlines remain separate from saleable parcel inventory; no plot is offered or assigned.
                      </div>
                    </FormStep>
                  ) : null}

                  {activeStep === 2 ? (
                    <FormStep title="Map-Outline Preferences" goal={applicationSteps[2].goal}>
                      {modules.map ? (
                        <div className="grid gap-3">
                          <div className="grid gap-2">
                            <div className="min-w-0 overflow-visible rounded-xl border border-border">
                              <PublicLotMap
                                tenantSlug={HOPKINS_SCOPE.tenant}
                                projectSlug={HOPKINS_SCOPE.project}
                                phaseSlug={HOPKINS_SCOPE.phase}
                                showPrices={modules.pricing}
                                enableInquiry
                                initialView="tier"
                                initialFit="outlines"
                                detailsPlacement="below"
                                localDemoOnly={localDemoOnly}
                                selectedMapFeatureRefs={selectedMapFeatureRefs}
                                onToggleMapFeature={onToggleMapFeature}
                                onParcelsLoaded={handleMapParcelsLoaded}
                              />
                            </div>
                            <p className="text-xs text-muted-foreground">Choose up to {maxMapPreferences} optional references. Outlines are map references, not saleable parcel IDs; selecting one does not reserve or allocate a lot.</p>
                          </div>
                          <fieldset className="grid gap-3 rounded-xl border border-primary/15 bg-primary-soft/25 p-4">
                            <legend className="px-1 text-sm font-semibold text-primary">Selected map references</legend>
                            <p className="text-sm leading-5 text-muted-foreground">These preferences are optional. You can still submit a general project application without selecting an outline.</p>
                            {visibleMapLabels.length ? (
                              <ul className="grid gap-3 sm:grid-cols-2">
                                {visibleMapLabels.map(({ ref, label }) => (
                                  <li key={ref} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-sm">
                                    <span className="min-w-0 truncate font-semibold text-primary">{label}</span>
                                    <button type="button" className="min-h-9 shrink-0 rounded-md px-3 font-semibold text-secondary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" onClick={() => onRemoveMapFeature(ref)}>Remove</button>
                                  </li>
                                ))}
                              </ul>
                            ) : <p className="text-sm text-muted-foreground">No map outlines selected.</p>}
                            {mapPreferenceError || mapLoadError ? <p role="alert" className="text-sm text-danger">{mapPreferenceError || mapLoadError}</p> : null}
                          </fieldset>
                        </div>
                      ) : <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">Map preferences are not enabled for this project. You may continue with general project interest.</p>}
                    </FormStep>
                  ) : null}

                  {activeStep === 3 ? (
                    <FormStep title="Additional Details" goal={applicationSteps[3].goal}>
                      <div className="grid gap-6">
                        <div className="rounded-xl border border-secondary/25 bg-[#fff8e6] p-4 shadow-sm shadow-secondary/10">
                          <p className="text-sm font-semibold text-primary">Questions before applying?</p>
                          <p className="mt-1 text-sm leading-5 text-muted-foreground">The Hopkins team reviews applications directly. No payment method, parcel purchase, or lot allocation is part of this form.</p>
                        </div>
                        <Field label="Anything else the Hopkins team should know? (optional)"><Textarea name="notes" maxLength={2000} rows={5} value={draft.notes} onChange={(event) => updateDraft("notes", event.target.value)} /></Field>
                      </div>
                    </FormStep>
                  ) : null}

                  {activeStep === 4 ? (
                    <FormStep title="Review & Acknowledge" goal={applicationSteps[4].goal}>
                      <div className="grid gap-4">
                        <ReviewGroup title="Applicant" step={0} onEdit={setActiveStep} rows={[
                          ["Full name", draft.name], ["Address", draft.address], ["Nationality", draft.nationality], ["Occupation", draft.occupation], ["Telephone", draft.phone], ["Email", draft.email],
                        ]} />
                        <ReviewGroup title="Project interest" step={1} onEdit={setActiveStep} rows={[
                          ["Intended use", draft.intendedUse === "Other" ? `Other: ${draft.otherUse}` : draft.intendedUse],
                        ]} />
                        <ReviewGroup title="Map preferences" step={2} onEdit={setActiveStep} rows={[
                          ["Outline references", visibleMapLabels.map(({ label }) => label).join(", ") || "None"],
                        ]} />
                        {draft.notes ? <ReviewGroup title="Additional details" step={3} onEdit={setActiveStep} rows={[["Notes", draft.notes]]} /> : null}
                        <div className="rounded-xl border border-border bg-card p-4 text-sm leading-6 shadow-sm shadow-primary/5">
                          <p className="font-semibold text-primary">Hopkins project notice</p>
                          <p className="mt-2 text-muted-foreground">{applicationSettings.publicNotice}</p>
                          <p className="mt-3 border-t border-border pt-3 text-muted-foreground">{applicationSettings.acknowledgmentText}</p>
                        </div>
                        <label className="flex gap-3 rounded-xl border border-success/20 bg-success/10 p-4 text-sm">
                          <input type="checkbox" className="mt-1" checked={draft.acknowledged} onChange={(event) => updateDraft("acknowledged", event.target.checked)} />
                          <span>
                            I acknowledge that this application is for Hopkins Grove staff review and does not allocate or reserve a parcel.
                            {fieldErrors.acknowledged ? <span className="mt-1 block text-danger">{fieldErrors.acknowledged}</span> : null}
                          </span>
                        </label>
                        <Field label="Type your full name as acknowledgement" error={fieldErrors.signature}><Input name="applicant_acknowledgement_signature" autoComplete="name" maxLength={160} required value={draft.signature} onChange={(event) => updateDraft("signature", event.target.value)} /></Field>
                      </div>
                    </FormStep>
                  ) : null}
                </div>

                {activeStep === 2 ? null : (
                  <aside className="hidden border-primary/10 bg-primary/95 p-5 text-white lg:block lg:border-l lg:p-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/65">Application Summary</p>
                    <div className="mt-5 grid gap-2 text-sm">
                      <SummaryLine label="Project" value={projectName} />
                      <SummaryLine label="Step" value={`${activeStep + 1} of ${applicationSteps.length}`} />
                      {summaryRows.map((row) => <SummaryLine key={row.label} {...row} />)}
                    </div>
                    <div className="mt-6 rounded-lg border border-white/15 bg-white/[0.06] p-4 text-sm leading-6 text-white/80">
                      This application is for staff review. It does not reserve or assign a map outline or parcel.
                    </div>
                  </aside>
                )}
              </div>

              {activeStep === 2 ? (
                <details className="border-t border-border bg-muted/25 px-4 py-3 sm:px-5 lg:px-7" data-testid="map-step-application-summary">
                  <summary className="focus-ring min-h-11 cursor-pointer py-2 text-sm font-semibold text-primary">Application summary</summary>
                  <div className="grid gap-2 pb-2 text-sm sm:grid-cols-2">
                    <SummaryLine label="Project" value={projectName} />
                    <SummaryLine label="Step" value={`${activeStep + 1} of ${applicationSteps.length}`} />
                    {summaryRows.map((row) => <SummaryLine key={row.label} {...row} />)}
                    <p className="sm:col-span-2 rounded-md border border-border bg-card p-3 text-xs leading-5 text-muted-foreground">Map references are optional preferences. This application does not reserve or assign an outline or parcel.</p>
                  </div>
                </details>
              ) : null}

              <div className="flex flex-col-reverse gap-3 border-t border-border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
                <Button type="button" variant="outline" disabled={activeStep === 0 || submitting} onClick={() => setActiveStep((step) => Math.max(step - 1, 0))}>
                  <ArrowLeft className="h-4 w-4" />Back
                </Button>
                {activeStep < applicationSteps.length - 1 ? (
                  <Button type="button" onClick={continueToNextStep}>Continue<ArrowRight className="h-4 w-4" /></Button>
                ) : (
                  <Button disabled={submitting}>{submitting ? "Submitting…" : "Submit application"}<Send className="ml-2 h-4 w-4" /></Button>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ReviewGroup({ title, step, rows, onEdit }: { title: string; step: number; rows: Array<[string, string]>; onEdit: (step: number) => void }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-semibold text-primary">{title}</h4>
        <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={() => onEdit(step)}>Edit</Button>
      </div>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => <div key={label}><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="break-words text-sm text-foreground">{value || "Not entered"}</dd></div>)}
      </dl>
    </section>
  );
}
