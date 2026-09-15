import { useState, type FormEvent } from "react";
import { supabase } from "../../lib/supabase";
import { edgeFunctionErrorMessage } from "../../lib/functions";
import { Button } from "../ui/Button";
import { Field, Input, Textarea } from "../ui/Field";
import { ErrorState } from "../ui/State";

interface PublicInquiryModalProps {
  tenantSlug: string;
  tenantName: string;
  lotId: number;
  lotNumber: string;
  onClose: () => void;
}

export function PublicInquiryModal({ tenantSlug, tenantName, lotId, lotNumber, onClose }: PublicInquiryModalProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState(`I am interested in reserving Lot ${lotNumber}`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !email.trim()) {
      setError("Enter your name and email so the team can follow up.");
      return;
    }
    setSubmitting(true);
    try {
      const { data, error: functionError } = await supabase.functions.invoke("submit-public-inquiry", {
        body: {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          interests: ["Available lots", "A specific lot"],
          specific_lot_id: lotId,
          message: message.trim() || undefined,
          page_url: window.location.href,
          tenant: tenantSlug,
        },
      });
      if (functionError) throw new Error(edgeFunctionErrorMessage(functionError));
      if (data?.error) throw new Error(String(data.error));
      setSent(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "We could not send your inquiry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`Inquire about Lot ${lotNumber}`}>
      <button type="button" aria-label="Close inquiry form" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-md rounded-lg bg-background p-5 shadow-xl">
        {sent ? (
          <div className="grid gap-3 text-center">
            <h2 className="font-display text-xl font-semibold text-primary">Inquiry Sent!</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              The development team will reach out to you shortly about Lot {lotNumber}.
            </p>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
            <div>
              <h2 className="font-display text-xl font-semibold text-primary">Inquire About Lot {lotNumber}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{tenantName}</p>
            </div>
            {error ? <ErrorState message={error} /> : null}
            <Field label="Full Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} required />
            </Field>
            <Field label="Email Address">
              <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" maxLength={254} required />
            </Field>
            <Field label="Phone / WhatsApp (optional)">
              <Input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" maxLength={40} />
            </Field>
            <Field label="Note / Message">
              <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Sending…" : "Send Inquiry"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
