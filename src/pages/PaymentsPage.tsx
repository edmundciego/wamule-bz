import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PageHeader } from "../components/layout/PageHeader";
import { PaymentDocumentLinks } from "../components/payments/PaymentDocumentLinks";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { UploadFileSummary } from "../components/uploads/UploadFileSummary";
import { supabase } from "../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../lib/uploads";
import { formatDate, money } from "../lib/utils";
import type { CollectionMethod, TransactionType } from "../types/database";

const transactionTypes: TransactionType[] = ["Down Payment", "Land Installment", "Garbage Fee", "Road Maintenance"];
const collectionMethods: CollectionMethod[] = ["Cash", "Online Transfer"];
const documentTypes = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"] as const;

export function PaymentsPage() {
  const queryClient = useQueryClient();
  const [receiptSearch, setReceiptSearch] = useState("");
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

  return (
    <>
      <PageHeader title="Payments" description="Unified ledger for land installments and community fees." />
      {isLoading ? <LoadingState /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="grid min-w-0 content-start gap-3">
          <Card>
            <CardContent className="p-4">
              <Field label="Search manual receipt number">
                <Input value={receiptSearch} onChange={(event) => setReceiptSearch(event.target.value)} placeholder="Receipt number" />
              </Field>
            </CardContent>
          </Card>
          {filteredPayments.map((payment) => (
            <Card key={payment.id}>
              <CardContent className="grid gap-2 p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-3">
                  <p className="font-medium text-foreground">{payment.customers?.first_name} {payment.customers?.last_name}</p>
                  <Badge tone={["Down Payment", "Land Installment"].includes(payment.transaction_type) ? "blue" : "amber"}>{payment.transaction_type}</Badge>
                </div>
                <p className="text-muted-foreground">
                  Lot {payment.contracts?.parcels?.lot_number ?? "N/A"} | {money(payment.amount)} by {payment.collection_method} on {formatDate(payment.created_at)}
                </p>
                <p className="text-muted-foreground">Reference: {payment.bank_reference ?? "Cash"}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span>Manual receipt: {payment.manual_receipt_number ?? "Missing"}</span>
                  {payment.manual_receipt_number ? <Badge tone="green">Recorded</Badge> : <Badge tone="amber">Missing receipt #</Badge>}
                </div>
                <p className="text-muted-foreground">Receipt date: {payment.receipt_date ? formatDate(payment.receipt_date) : "Not recorded"}</p>
                <PaymentDocumentLinks documents={payment.payment_documents} />
                <ExistingPaymentDocumentUpload
                  payment={{
                    id: payment.id,
                    customer_id: payment.customer_id,
                  }}
                  onUploaded={() => queryClient.invalidateQueries({ queryKey: ["payments"] })}
                />
                <PaymentEditor
                  payment={{
                    id: payment.id,
                    amount: payment.amount,
                    transaction_type: payment.transaction_type,
                    collection_method: payment.collection_method,
                    bank_reference: payment.bank_reference,
                    notes: payment.notes,
                    manual_receipt_number: payment.manual_receipt_number,
                    receipt_date: payment.receipt_date,
                    receipt_issued_by: payment.receipt_issued_by,
                    receipt_notes: payment.receipt_notes,
                  }}
                  onSaved={() => queryClient.invalidateQueries({ queryKey: ["payments"] })}
                />
              </CardContent>
            </Card>
          ))}
        </div>
        <PaymentForm />
      </div>
    </>
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
    <details className="crm-subpanel">
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

function PaymentEditor({
  payment,
  onSaved,
}: {
  payment: {
    id: number;
    amount: number;
    transaction_type: TransactionType;
    collection_method: CollectionMethod;
    bank_reference: string | null;
    notes: string | null;
    manual_receipt_number: string | null;
    receipt_date: string | null;
    receipt_issued_by: string | null;
    receipt_notes: string | null;
  };
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(String(payment.amount));
  const [transactionType, setTransactionType] = useState<TransactionType>(payment.transaction_type);
  const [collectionMethod, setCollectionMethod] = useState<CollectionMethod>(payment.collection_method);
  const [bankReference, setBankReference] = useState(payment.bank_reference ?? "");
  const [notes, setNotes] = useState(payment.notes ?? "");
  const [manualReceiptNumber, setManualReceiptNumber] = useState(payment.manual_receipt_number ?? "");
  const [receiptDate, setReceiptDate] = useState(payment.receipt_date ?? "");
  const [receiptIssuedBy, setReceiptIssuedBy] = useState(payment.receipt_issued_by ?? "");
  const [receiptNotes, setReceiptNotes] = useState(payment.receipt_notes ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveReceiptDetails() {
    if (collectionMethod === "Online Transfer" && !bankReference.trim()) {
      setStatus("Bank reference is required for online transfers.");
      return;
    }

    setSaving(true);
    setStatus(null);
    const { error } = await supabase
      .from("transactions")
      .update({
        amount: Number(amount),
        transaction_type: transactionType,
        collection_method: collectionMethod,
        bank_reference: bankReference.trim() || null,
        notes: notes.trim() || null,
        manual_receipt_number: manualReceiptNumber.trim() || null,
        receipt_date: receiptDate || null,
        receipt_issued_by: receiptIssuedBy.trim() || null,
        receipt_notes: receiptNotes.trim() || null,
      })
      .eq("id", payment.id);
    setSaving(false);
    if (error) {
      setStatus(error.message);
      return;
    }
    setStatus("Receipt details saved.");
    onSaved();
  }

  return (
    <details className="crm-subpanel">
      <summary className="cursor-pointer text-sm font-medium text-primary">Edit payment details</summary>
      <div className="mt-3 grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount">
            <Input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
          <Field label="Transaction type">
            <Select value={transactionType} onChange={(event) => setTransactionType(event.target.value as TransactionType)}>
              {transactionTypes.map((transactionTypeOption) => <option key={transactionTypeOption}>{transactionTypeOption}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Collection method">
            <Select value={collectionMethod} onChange={(event) => setCollectionMethod(event.target.value as CollectionMethod)}>
              {collectionMethods.map((collectionMethodOption) => <option key={collectionMethodOption}>{collectionMethodOption}</option>)}
            </Select>
          </Field>
          <Field label="Bank reference">
            <Input value={bankReference} onChange={(event) => setBankReference(event.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Manual receipt number">
            <Input value={manualReceiptNumber} onChange={(event) => setManualReceiptNumber(event.target.value)} />
          </Field>
          <Field label="Receipt date">
            <Input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} />
          </Field>
        </div>
        <Field label="Receipt issued by">
          <Input value={receiptIssuedBy} onChange={(event) => setReceiptIssuedBy(event.target.value)} />
        </Field>
        <Field label="Receipt notes">
          <Textarea value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} />
        </Field>
        <Field label="Payment notes">
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        {status ? <p className="crm-info-panel p-3 text-xs">{status}</p> : null}
        <div>
          <Button type="button" disabled={saving} onClick={() => void saveReceiptDetails()}>
            {saving ? "Saving..." : "Save payment details"}
          </Button>
        </div>
      </div>
    </details>
  );
}
