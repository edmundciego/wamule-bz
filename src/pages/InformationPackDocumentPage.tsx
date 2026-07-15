import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { ErrorState, LoadingState } from "../components/ui/State";
import { supabase } from "../lib/supabase";
import { formatDate, money } from "../lib/utils";
import type { InstallmentPlan, Parcel } from "../types/database";

type Snapshot = {
  company: {
    company_name: string;
    logo_url: string;
    contact_email: string;
    phone_number: string;
    website: string;
    location_address: string;
    short_description: string;
  };
  project: {
    name: string;
    description: string;
    location: string;
  };
  recipient: {
    name: string;
    email: string | null;
    phone: string | null;
  };
  selected_lot: Pick<Parcel, "id" | "lot_number" | "base_price" | "status" | "dimensions"> | null;
  availability: {
    available_count: number;
    minimum_price: number | null;
    maximum_price: number | null;
  };
  topics: Array<{
    code: string;
    name: string;
    description: string | null;
    content: string;
  }>;
  payment_plans: Array<Pick<InstallmentPlan, "id" | "name" | "description" | "reservation_fee" | "initial_deposit" | "final_purchase_price" | "term_months" | "monthly_payment">>;
  custom_request: string | null;
  next_step: string;
  generated_at: string;
};

type Pack = {
  id: string;
  document_number: string;
  title: string;
  status: "draft" | "approved" | "superseded";
  version: number;
  introduction: string | null;
  content_snapshot: Snapshot;
  generated_at: string;
  approved_at: string | null;
};

export function InformationPackDocumentPage() {
  const { id } = useParams();
  const { data: pack, isLoading, error } = useQuery({
    queryKey: ["information-pack-document", id],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("information_packs")
        .select("id, document_number, title, status, version, introduction, content_snapshot, generated_at, approved_at")
        .eq("id", id)
        .single();
      if (queryError) throw queryError;
      return data as Pack;
    },
    enabled: Boolean(id),
  });

  return (
    <main className="min-h-screen bg-background p-4 print:bg-white print:p-0">
      <div className="print-hidden mx-auto mb-4 flex max-w-4xl flex-wrap items-center justify-between gap-3">
        <Link className="text-sm font-medium text-primary hover:text-copper" to="/information-centre">
          Back to Information Centre
        </Link>
        <Button type="button" onClick={() => window.print()} disabled={!pack}>
          Print / Save PDF
        </Button>
      </div>
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {pack ? <InformationPackDocument pack={pack} /> : null}
    </main>
  );
}

function InformationPackDocument({ pack }: { pack: Pack }) {
  const snapshot = pack.content_snapshot;
  const company = snapshot.company;

  return (
    <article className="mx-auto max-w-4xl rounded-lg border bg-white p-8 shadow-sm print:max-w-none print:rounded-none print:border-0 print:p-10 print:shadow-none">
      <header className="flex min-h-[230px] flex-col justify-between border-b border-copper/30 pb-8">
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-center gap-4">
            <img src={company.logo_url} alt={company.company_name} className="h-20 w-20 rounded-md border bg-ivory object-cover" />
            <div>
              <p className="font-display text-3xl font-semibold text-primary">{company.company_name}</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.28em] text-copper">Buyer Information</p>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>Document: {pack.document_number}</p>
            <p>Version: {pack.version}</p>
            <p>Generated: {formatDate(pack.generated_at)}</p>
            <p>Status: {pack.status === "approved" ? "Approved" : "Draft for staff review"}</p>
          </div>
        </div>
        <div className="mt-12">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-copper">Prepared for</p>
          <h1 className="mt-2 font-display text-4xl font-semibold text-primary">{snapshot.recipient.name}</h1>
          <p className="mt-2 text-lg text-muted-foreground">{pack.title}</p>
        </div>
      </header>

      <section className="mt-8">
        <p className="text-base leading-7 text-slate">{pack.introduction}</p>
      </section>

      <section className="mt-8 rounded-lg border bg-ivory/40 p-5">
        <h2 className="font-display text-2xl font-semibold text-primary">About {snapshot.project.name}</h2>
        <p className="mt-3 text-sm leading-6 text-slate">{snapshot.project.description}</p>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <Info label="Location" value={snapshot.project.location || "Contact the company for location information."} />
          <Info label="Current available lots" value={String(snapshot.availability.available_count)} />
          <Info label="Current price range" value={priceRange(snapshot.availability.minimum_price, snapshot.availability.maximum_price)} />
          <Info label="Selected lot" value={snapshot.selected_lot ? `Lot ${snapshot.selected_lot.lot_number}` : "No specific lot selected"} />
        </dl>
      </section>

      {snapshot.selected_lot ? (
        <section className="mt-8 break-inside-avoid rounded-lg border p-5">
          <h2 className="font-display text-2xl font-semibold text-primary">Selected Lot</h2>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <Info label="Lot" value={`Lot ${snapshot.selected_lot.lot_number}`} />
            <Info label="Status at generation" value={snapshot.selected_lot.status} />
            <Info label="Dimensions" value={snapshot.selected_lot.dimensions || "Not recorded"} />
            <Info label="Listed base price" value={money(snapshot.selected_lot.base_price)} />
          </dl>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Lot status and pricing must be reconfirmed by staff before reservation, payment, application approval, or contract preparation.
          </p>
        </section>
      ) : null}

      <div className="mt-8 grid gap-7">
        {snapshot.topics.map((topic) => (
          <section key={topic.code} className="break-inside-avoid border-b border-border pb-7 last:border-b-0">
            <h2 className="font-display text-2xl font-semibold text-primary">{topic.name}</h2>
            {topic.description ? <p className="mt-1 text-sm font-medium text-copper">{topic.description}</p> : null}
            <p className="mt-3 whitespace-pre-line text-sm leading-7 text-slate">{topic.content}</p>
            {topic.code === "current_lot_availability" ? (
              <div className="mt-4 rounded-md border bg-ivory/40 p-4 text-sm">
                Current snapshot: {snapshot.availability.available_count} lot(s) marked available, with recorded prices from {priceRange(snapshot.availability.minimum_price, snapshot.availability.maximum_price)}.
              </div>
            ) : null}
          </section>
        ))}
      </div>

      {snapshot.payment_plans.length > 0 ? (
        <section className="mt-8 break-before-auto">
          <h2 className="font-display text-2xl font-semibold text-primary">Available Payment Plan Examples</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            These are the active plan settings at the time this pack was generated. Staff must confirm the plan that applies to the selected lot and buyer.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {snapshot.payment_plans.map((plan) => (
              <article key={plan.id} className="break-inside-avoid rounded-lg border p-4">
                <h3 className="font-semibold text-primary">{plan.name}</h3>
                {plan.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{plan.description}</p> : null}
                <dl className="mt-3 grid gap-2 text-sm">
                  <PlanRow label="Reservation fee" value={money(plan.reservation_fee)} />
                  <PlanRow label="Initial deposit" value={money(plan.initial_deposit)} />
                  <PlanRow label="Example purchase price" value={money(plan.final_purchase_price)} />
                  <PlanRow label="Term" value={`${plan.term_months} months`} />
                  <PlanRow label="Monthly payment" value={money(plan.monthly_payment)} />
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {snapshot.custom_request ? (
        <section className="mt-8 break-inside-avoid rounded-lg border p-5">
          <h2 className="font-display text-2xl font-semibold text-primary">Your Additional Request</h2>
          <p className="mt-3 whitespace-pre-line text-sm leading-7 text-slate">{snapshot.custom_request}</p>
        </section>
      ) : null}

      <section className="mt-8 break-inside-avoid rounded-lg bg-primary p-6 text-primary-foreground">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-secondary">Recommended next step</p>
        <p className="mt-3 text-base leading-7">{snapshot.next_step}</p>
      </section>

      <footer className="mt-10 border-t pt-5 text-xs leading-5 text-muted-foreground">
        <div className="grid gap-1 sm:grid-cols-2">
          <p>{company.company_name}</p>
          <p className="sm:text-right">{company.location_address}</p>
          <p>{company.contact_email || "Email available from your representative"}</p>
          <p className="sm:text-right">{company.phone_number || company.website || "Contact your assigned representative"}</p>
        </div>
        <p className="mt-4">
          This information pack is provided for discussion and staff follow-up. It does not reserve a lot, approve an application, confirm a payment, create a contract, guarantee availability, or replace the final signed agreement and applicable professional advice.
        </p>
      </footer>
    </article>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-white p-3">
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-copper">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-primary">{value}</dd>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-primary">{value}</dd>
    </div>
  );
}

function priceRange(minimum: number | null, maximum: number | null) {
  if (minimum === null || maximum === null) return "Contact staff for current pricing";
  if (minimum === maximum) return money(minimum);
  return `${money(minimum)} – ${money(maximum)}`;
}
