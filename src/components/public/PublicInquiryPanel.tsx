import { Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { buildInquiryPayload, INQUIRY_LIMITS, type InquiryInterest } from "../../../supabase/functions/_shared/inquiry-contract";
import type { PublicParcelOption } from "../../lib/publicApplicationPlots";
import type { PublicExperienceScope } from "../../lib/publicExperience.mjs";
import type { PublicSiteData } from "../../lib/publicSiteExperience";
import { submitPublicFunction } from "../../lib/publicSubmission";
import { cn, money } from "../../lib/utils";
import { Button } from "../ui/Button";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { ErrorState } from "../ui/State";

const inquiryInterests = [
  "Available lots",
  "Lot pricing",
  "Payment options",
  "Site visit",
  "Buying process",
  "A specific lot",
] as const satisfies readonly InquiryInterest[];
const specificLotInterest = "A specific lot";

function newRequestReference() {
  return globalThis.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const digit = Math.floor(Math.random() * 16);
    return (part === "x" ? digit : (digit & 0x3) | 0x8).toString(16);
  });
}

export function PublicInquiryPanel({
  scope,
  company,
  projectName,
  salesInquiry,
  parcels,
  showPrices,
}: {
  scope: PublicExperienceScope;
  company: PublicSiteData["company"];
  projectName: string;
  salesInquiry: boolean;
  parcels: PublicParcelOption[];
  showPrices: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [interests, setInterests] = useState<InquiryInterest[]>([]);
  const [specificLotRef, setSpecificLotRef] = useState("");
  const [clientReferenceId, setClientReferenceId] = useState(newRequestReference);
  const [confirmation, setConfirmation] = useState<{ emailSent: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const specificLotSelected = interests.includes(specificLotInterest);

  async function submitInquiry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !email.trim()) {
      setError("Enter your name and email so the team can follow up.");
      return;
    }
    if (specificLotSelected && !parcels.some((lot) => lot.public_ref === specificLotRef)) {
      setError("Choose an available lot to ask about.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitPublicFunction<{ emailSent?: boolean }>("submit-public-inquiry", buildInquiryPayload({
        name,
        email,
        phone,
        interests: interests.length ? interests : ["General project interest"],
        specificLotRef: specificLotSelected && specificLotRef ? specificLotRef : null,
        message,
        pageUrl: window.location.href,
        tenant: scope.tenantSlug,
        project: scope.projectSlug,
        phase: scope.phaseSlug,
        clientReferenceId,
      }));
      setConfirmation({ emailSent: Boolean(result?.emailSent) });
      setName("");
      setEmail("");
      setPhone("");
      setMessage("");
      setInterests([]);
      setSpecificLotRef("");
      setClientReferenceId(newRequestReference());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "We could not send your inquiry. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-10">
      <div className="min-w-0">
        <h2 id="inquiry-title" className="font-display text-2xl font-semibold text-primary sm:text-3xl">Request project information</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Ask the {company.company_name} team about {projectName}.</p>
        <div className="mt-4 grid gap-2 text-sm font-medium text-primary">
          {company.contact_email ? <a className="w-fit break-all underline" href={`mailto:${company.contact_email}`}>{company.contact_email}</a> : null}
          {company.phone_number ? <a className="w-fit underline" href={`tel:${company.phone_number.replace(/[^+\d]/g, "")}`}>{company.phone_number}</a> : null}
        </div>
      </div>

      {confirmation ? (
        <div role="status" className="grid justify-items-start gap-3 rounded-xl border border-success/20 bg-success/10 p-4">
          <p className="font-semibold text-primary">Your inquiry was received.</p>
          <p className="text-sm text-muted-foreground">{confirmation.emailSent ? "Check your email for confirmation." : "The project team can follow up using your contact details."}</p>
          <Button type="button" variant="outline" onClick={() => setConfirmation(null)}>Send another inquiry</Button>
        </div>
      ) : (
        <form aria-labelledby="inquiry-title" className="grid gap-4" onSubmit={(event) => void submitInquiry(event)}>
          {error ? <ErrorState message={error} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name"><Input name="name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={INQUIRY_LIMITS.name} required /></Field>
            <Field label="Email address"><Input name="email" value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" maxLength={INQUIRY_LIMITS.email} required /></Field>
          </div>
          <Field label="Phone / WhatsApp (optional)"><Input name="phone" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" maxLength={INQUIRY_LIMITS.phone} /></Field>
          {salesInquiry ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">What would you like to know?</legend>
              <div className="flex flex-wrap gap-2">
                {inquiryInterests.filter((interest) => interest !== specificLotInterest || parcels.length > 0).map((interest) => {
                  const selected = interests.includes(interest);
                  return (
                    <button
                      key={interest}
                      type="button"
                      aria-pressed={selected}
                      className={cn("min-h-10 rounded-md border px-3 text-sm font-medium", selected ? "border-primary bg-primary-soft text-primary" : "border-border bg-card hover:bg-muted")}
                      onClick={() => {
                        setInterests(selected ? interests.filter((item) => item !== interest) : [...interests, interest]);
                        if (selected && interest === specificLotInterest) setSpecificLotRef("");
                      }}
                    >{interest}</button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          {specificLotSelected ? (
            <Field label="Specific lot">
              <Select value={specificLotRef} onChange={(event) => setSpecificLotRef(event.target.value)} required>
                <option value="">Select a lot</option>
                {parcels.map((parcel) => (
                  <option key={parcel.public_ref} value={parcel.public_ref}>
                    Lot {parcel.lot_number}{parcel.dimensions ? ` · ${parcel.dimensions}` : ""}{showPrices && parcel.base_price > 0 ? ` · ${money(parcel.base_price)}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Message (optional)"><Textarea name="message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={INQUIRY_LIMITS.message} rows={3} /></Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Your details are used to respond to this inquiry.</p>
            <Button type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send inquiry"}<Send aria-hidden="true" className="h-4 w-4" /></Button>
          </div>
        </form>
      )}
    </div>
  );
}
