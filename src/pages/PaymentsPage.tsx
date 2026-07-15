import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PaymentDocumentLinks } from "../components/payments/PaymentDocumentLinks";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Field, Input, Select } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { UploadFileSummary } from "../components/uploads/UploadFileSummary";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../lib/uploads";
import { formatDate, money } from "../lib/utils";
import type { AppRole } from "../types/database";

const documentTypes = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"] as const;

export function PaymentsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [receiptSearch, setReceiptSearch] = useState("");
  const [correctionOfTransactionId, setCorrectionOfTransactionId] = useState<number | null>(null);
  const requestedPaymentId = searchParams.get("payment");
  const { data: sessionProfile } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canRemovePayments = currentRole === "Super Admin" || currentRole === "Admin";
  const { data, isLoading, error } = useQuery({
    queryKey: ["payments"],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("transactions")
        .select("*, customers(first_name, last_name), contracts(id, parcels(lot_number)), payment_documents(*)")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return rows;
    },
  });
  const filteredPayments = useMemo(() => {
    const search = receiptSearch.trim().toLowerCase();
    if (!search) return data ?? [];
    return (
      data?.filter((payment) =>
        String(payment.manual_receipt_number ?? "").toLowerCase().includes(search),
      ) ?? []
    );
  }, [data, receiptSearch]);
  useEffect(() => {
    if (!requestedPaymentId || !data?.some((payment) => String(payment.id) === requestedPaymentId)) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>(`[data-payment-id="${requestedPaymentId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => window.clearTimeout(timer);
  }, [data, requestedPaymentId]);

  return (
    <section className="v2-page-shell">
      <div className="v2-page-header">
        <p className="v2-page-kicker">Financial Truth</p>
        <h1 className="v2-page-title">Payments</h1>
        <p className="v2-page-description">Unified ledger for land installments and community fees.</p>
      </div>
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="grid min-w-0 content-start gap-3">
          <Card className="v2-filter-bar">
            <CardContent className="p-4">
              <Field label="Search manual receipt number">
                <Input value={receiptSearch} onChange={(event) => setReceiptSearch(event.target.value)} placeholder="Receipt number" />
              </Field>
            </CardContent>
          </Card>
          {filteredPayments.map((payment) => (
            <Card key={payment.id} data-payment-id={payment.id} className={`v2-ledger-panel ${requestedPaymentId === String(payment.id) ? "ring-2 ring-accent ring-offset-2" : ""}`}>
              <CardContent className="grid gap-3 p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <p className="font-semibold text-primary">{payment.customers?.first_name} {payment.customers?.last_name}</p>
                    <p className="mt-1 text-muted-foreground">Lot {payment.contracts?.parcels?.lot_number ?? "N/A"} · {formatDate(payment.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="v2-money text-xl">{money(payment.amount)}</p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Badge tone={["Down Payment", "Land Installment"].includes(payment.transaction_type) ? "blue" : "amber"}>{payment.transaction_type}</Badge>
                      {payment.status === "voided" ? <Badge tone="red">Voided</Badge> : null}
                      {payment.status === "reversed" ? <Badge tone="gray">Reversed</Badge> : null}
                    </div>
                  </div>
                </div>
                <div className="grid gap-2 border-t border-border/80 pt-3 text-muted-foreground sm:grid-cols-3">
                  <span>Method: {payment.collection_method}</span>
                  <span>Reference: {payment.bank_reference ?? "Cash"}</span>
                  <span>Receipt date: {payment.receipt_date ? formatDate(payment.receipt_date) : "Not recorded"}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Manual receipt: {payment.manual_receipt_number ?? "Missing"}</span>
                  {payment.manual_receipt_number ? <Badge tone="green">Recorded</Badge> : <Badge tone="amber">Missing receipt #</Badge>}
                </div>
                <PaymentDocumentLinks documents={payment.payment_documents} />
                <ExistingPaymentDocumentUpload
                  payment={{
                    id: payment.id,
                    customer_id: payment.customer_id,
                  }}
                  onUploaded={() => queryClient.invalidateQueries({ queryKey: ["payments"] })}
                />
                {payment.status === "posted" && canRemovePayments ? (
                  <PaymentVoidControl
                    payment={payment}
                    onVoided={async () => {
                      setCorrectionOfTransactionId(payment.id);
                      await queryClient.invalidateQueries();
                    }}
                  />
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="xl:sticky xl:top-6">
          <PaymentForm correctionOfTransactionId={correctionOfTransactionId} onSuccess={() => setCorrectionOfTransactionId(null)} />
        </div>
      </div>
    </section>
  );
}

function PaymentVoidControl({
  payment,
  onVoided,
}: {
  payment: {
    id: number;
    amount: number;
    created_at: string;
    collection_method: string;
    bank_reference: string | null;
    receipt_number: string;
    manual_receipt_number: string | null;
    customers?: { first_name: string; last_name: string } | null;
  };
  onVoided: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  async function voidPayment() {
    if (reason.trim().length < 3) {
      setStatus("Enter a reason for voiding this payment.");
      return;
    }
    setRemoving(true);
    setStatus(null);
    const { error } = await supabase.rpc("void_payment_record", {
      p_transaction_id: payment.id,
      p_reason: reason.trim(),
    });
    setRemoving(false);
    if (error) {
      setStatus(error.message);
      return;
    }
    await onVoided();
    setStatus("Payment voided. The original record and documents remain in history and the current ledger excludes it.");
    setOpen(false);
  }

  return (
    <details className="rounded-md border border-danger/20 bg-danger/5 p-3" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm font-medium text-danger">Void payment</summary>
      <div className="mt-3 grid gap-3 text-sm">
        <div className="grid gap-1 rounded border border-danger/15 bg-card p-3 text-muted-foreground">
          <span>Customer: {payment.customers ? `${payment.customers.first_name} ${payment.customers.last_name}` : "Not recorded"}</span>
          <span>Payment date: {formatDate(payment.created_at)}</span>
          <span>Amount: {money(payment.amount)}</span>
          <span>Method: {payment.collection_method}</span>
          <span>Reference: {payment.bank_reference ?? payment.manual_receipt_number ?? payment.receipt_number}</span>
        </div>
        <p className="text-muted-foreground">The payment and its documents remain in history. Voiding excludes it from current totals; record a linked replacement only if a correction is needed.</p>
        <Field label="Void reason">
          <textarea className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this payment entry must be voided" />
        </Field>
        {status ? <p className="text-sm text-danger">{status}</p> : null}
        <div>
          <Button type="button" variant="danger" disabled={removing} onClick={() => void voidPayment()}>
            {removing ? "Voiding..." : "Confirm void"}
          </Button>
        </div>
      </div>
    </details>
  );
}

function ExistingPaymentDocumentUpload({
  payment,
  onUploaded,
}: {
  payment: {
    id: number;
    customer_id: number;
  };
  onUploaded: () => void;
}) {
  const [documentType, setDocumentType] = useState<(typeof documentTypes)[number]>("Manual Receipt Photo");
  const [documentFile, setDocumentFile] = useState<PreparedUploadFile | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function uploadDocument() {
    setStatus(null);
    if (!documentFile) {
      setStatus("Choose a file to upload.");
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (!userId) {
      setStatus("Your session has expired. Sign in again.");
      return;
    }

    setUploading(true);
    setStatus("Uploading document...");
    const safeName = documentFile.uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `${payment.customer_id}/${payment.id}/${Date.now()}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from("payment-documents")
      .upload(filePath, documentFile.uploadFile, { upsert: false });
    if (uploadError) {
      setUploading(false);
      setStatus(uploadError.message);
      return;
    }

    const { error: documentError } = await supabase.from("payment_documents").insert({
      transaction_id: payment.id,
      customer_id: payment.customer_id,
      document_type: documentType,
      file_path: filePath,
      original_file_name: documentFile.originalFile.name,
      uploaded_by: userId,
    });
    setUploading(false);
    if (documentError) {
      setStatus(documentError.message);
      return;
    }

    setDocumentFile(null);
    setStatus("Document uploaded.");
    onUploaded();
  }

  async function handleDocumentChange(file: File | undefined) {
    setDocumentFile(null);
    setStatus(null);
    if (!file) return;
    setStatus("Preparing file...");
    try {
      const prepared = await prepareUploadFile(file, "payment-document");
      setDocumentFile(prepared);
      setStatus(prepared.wasCompressed ? "Image compressed and ready to upload." : "File ready to upload.");
    } catch (fileError) {
      setStatus((fileError as Error).message);
    }
  }

  return (
    <details className="v2-workflow-panel p-3">
      <summary className="cursor-pointer text-sm font-medium text-primary">Upload document to this payment</summary>
      <div className="mt-3 grid gap-3">
        <Field label="Document type">
          <Select value={documentType} onChange={(event) => setDocumentType(event.target.value as (typeof documentTypes)[number])}>
            {documentTypes.map((documentTypeOption) => <option key={documentTypeOption}>{documentTypeOption}</option>)}
          </Select>
        </Field>
        <Field label="Payment document">
          <Input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(event) => void handleDocumentChange(event.target.files?.[0])}
          />
        </Field>
        <UploadFileSummary file={documentFile} status={status} />
        <div>
          <Button type="button" disabled={uploading} onClick={() => void uploadDocument()}>
            {uploading ? "Uploading..." : "Upload document"}
          </Button>
        </div>
      </div>
    </details>
  );
}
