import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PaymentForm } from "../components/forms/PaymentForm";
import { PaymentDocumentLinks } from "../components/payments/PaymentDocumentLinks";
import { useWorkspaceScope } from "../components/auth/workspaceScopeContext";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { UploadFileSummary } from "../components/uploads/UploadFileSummary";
import { getSessionAndProfile } from "../lib/data";
import { supabase } from "../lib/supabase";
import { workspaceScopeKey } from "../lib/workspaceScope";
import { prepareUploadFile, type PreparedUploadFile } from "../lib/uploads";
import { formatDate, money } from "../lib/utils";
import type { AppRole } from "../types/database";

const documentTypes = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"] as const;

export function PaymentsPage() {
  const queryClient = useQueryClient();
  const { workspace, isLoading: workspaceLoading, error: workspaceError } = useWorkspaceScope();
  const scopeKey = workspaceScopeKey(workspace);
  const [searchParams] = useSearchParams();
  const [receiptSearch, setReceiptSearch] = useState("");
  const [correctionOfTransactionId, setCorrectionOfTransactionId] = useState<number | null>(null);
  const requestedPaymentId = searchParams.get("payment");
  const { data: sessionProfile } = useQuery({ queryKey: ["session-profile"], queryFn: getSessionAndProfile });
  const currentRole = sessionProfile?.profile?.role as AppRole | undefined;
  const canRemovePayments = currentRole === "Super Admin" || currentRole === "Admin";
  const { data, isLoading, error } = useQuery({
    queryKey: ["payments", scopeKey],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("transactions")
        .select("*, customers(first_name, last_name), contracts(id, parcels(lot_number)), payment_documents(*)")
        .eq("tenant_id", workspace!.tenantId)
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return rows;
    },
    enabled: Boolean(workspace),
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
      {workspaceLoading || isLoading ? <LoadingState /> : null}
      {!workspace && !workspaceLoading ? <ErrorState message={workspaceError ?? "Choose an accessible workspace to view its payments."} /> : null}
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {canRemovePayments && workspace ? (
        <details className="crm-info-panel mb-5 rounded-lg p-4">
          <summary className="cursor-pointer font-semibold text-primary">Assess a customer fee</summary>
          <div className="mt-4">
            <FeeChargeAssessmentForm onSuccess={() => queryClient.invalidateQueries()} />
          </div>
        </details>
      ) : null}
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

function FeeChargeAssessmentForm({ onSuccess }: { onSuccess: () => void }) {
  const { workspace } = useWorkspaceScope();
  const [customerId, setCustomerId] = useState("");
  const [feeTypeId, setFeeTypeId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [scopeKind, setScopeKind] = useState<"company" | "project" | "phase">("phase");
  const [saleParent, setSaleParent] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tenantId = workspace?.tenantId ?? null;
  const scopeKey = workspaceScopeKey(workspace);
  const { data: customers } = useQuery({
    queryKey: ["fee-charge-customers", scopeKey],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("customers").select("id, first_name, last_name")
        .eq("tenant_id", tenantId!).order("last_name");
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId),
  });
  const { data: feeTypes } = useQuery({
    queryKey: ["assessable-fee-types", scopeKey],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("fee_types").select("id, name, default_amount")
        .eq("tenant_id", tenantId!).eq("is_active", true).order("sort_order");
      if (queryError) throw queryError;
      return data.filter((fee) => ["Garbage Fee", "Road Maintenance"].includes(fee.name));
    },
    enabled: Boolean(tenantId),
  });
  const { data: paymentMethods } = useQuery({
    queryKey: ["assessable-fee-currencies", scopeKey],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("payment_methods").select("currency")
        .eq("tenant_id", tenantId!).eq("is_active", true).order("sort_order");
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId),
  });
  const currencies = Array.from(new Set((paymentMethods ?? []).map((item) => item.currency.toUpperCase()).filter((value) => /^[A-Z]{3}$/.test(value))));
  const { data: contracts } = useQuery({
    queryKey: ["fee-charge-contract-parents", scopeKey, customerId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("contracts").select("id, currency, parcels(lot_number)")
        .eq("tenant_id", tenantId!).eq("customer_id", Number(customerId))
        .eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId)
        .eq("status", "active").eq("is_active", true);
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId && customerId && workspace?.projectId && workspace.phaseId),
  });
  const { data: reservations } = useQuery({
    queryKey: ["fee-charge-reservation-parents", scopeKey, customerId],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("lot_reservations").select("id, currency, status")
        .eq("tenant_id", tenantId!).eq("customer_id", Number(customerId))
        .eq("project_id", workspace!.projectId).eq("phase_id", workspace!.phaseId)
        .in("status", ["reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"]);
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId && customerId && workspace?.projectId && workspace.phaseId && scopeKind === "phase"),
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!workspace || !customerId || !feeTypeId || !/^[A-Z]{3}$/.test(currency)
        || !currencies.includes(currency) || Number(amount) <= 0 || !description.trim()) {
      setError("Select a customer, supported currency, active fee type, positive amount and description.");
      return;
    }
    let contractId: number | null = null;
    let reservationId: string | null = null;
    if (saleParent) {
      if (scopeKind !== "phase") {
        setError("A fee attached to a contract or reservation must use its exact phase scope.");
        return;
      }
      const [kind, id] = saleParent.split(":");
      if (kind === "contract") contractId = Number(id);
      else if (kind === "reservation") reservationId = id;
      else {
        setError("Choose a valid same-phase contract or reservation.");
        return;
      }
    }
    setSaving(true);
    const { error: rpcError } = await supabase.rpc("assess_fee_charge_v1", {
      p_tenant_id: workspace.tenantId,
      p_customer_id: Number(customerId),
      p_fee_type_id: Number(feeTypeId),
      p_amount: Number(amount),
      p_currency: currency,
      p_scope_kind: scopeKind,
      p_project_id: scopeKind === "company" ? null : workspace.projectId,
      p_phase_id: scopeKind === "phase" ? workspace.phaseId : null,
      p_contract_id: contractId,
      p_reservation_id: reservationId,
      p_due_date: dueDate || null,
      p_description: description.trim(),
    });
    setSaving(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setMessage("Fee charge assessed in the selected tenant scope.");
    setAmount("");
    setDescription("");
    setSaleParent("");
    onSuccess();
  }

  return (
    <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => void submit(event)}>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="crm-success-panel p-3 text-sm">{message}</p> : null}
      <Field label="Customer">
        <Select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
          <option value="">Select a customer</option>
          {customers?.map((customer) => <option key={customer.id} value={customer.id}>{customer.first_name} {customer.last_name}</option>)}
        </Select>
      </Field>
      <Field label="Fee type">
        <Select value={feeTypeId} onChange={(event) => setFeeTypeId(event.target.value)}>
          <option value="">Select an active fee type</option>
          {feeTypes?.map((fee) => <option key={fee.id} value={fee.id}>{fee.name}{fee.default_amount ? ` · Default ${money(fee.default_amount)}` : ""}</option>)}
        </Select>
      </Field>
      <Field label="Amount">
        <Input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </Field>
      <Field label="Currency">
        <Select value={currency} onChange={(event) => setCurrency(event.target.value)}>
          <option value="">Select configured currency</option>
          {currencies.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
      </Field>
      <Field label="Financial scope">
        <Select value={scopeKind} onChange={(event) => { setScopeKind(event.target.value as typeof scopeKind); setSaleParent(""); }}>
          <option value="phase">Selected phase</option>
          <option value="project">Selected project</option>
          <option value="company">Entire company</option>
        </Select>
      </Field>
      {scopeKind === "phase" ? (
        <Field label="Optional sale link">
          <Select value={saleParent} onChange={(event) => setSaleParent(event.target.value)}>
            <option value="">No contract/reservation link</option>
            {contracts?.filter((item) => item.currency === currency).map((item) => <option key={`contract:${item.id}`} value={`contract:${item.id}`}>Contract #{item.id}</option>)}
            {reservations?.filter((item) => item.currency === currency).map((item) => <option key={`reservation:${item.id}`} value={`reservation:${item.id}`}>Reservation #{item.id}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field label="Due date">
        <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
      </Field>
      <div className="md:col-span-2"><Field label="Description">
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field></div>
      <div className="md:col-span-2"><Button disabled={saving}>{saving ? "Saving…" : "Assess fee charge"}</Button></div>
    </form>
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
  const { workspace } = useWorkspaceScope();
  const [documentType, setDocumentType] = useState<(typeof documentTypes)[number]>("Manual Receipt Photo");
  const [documentFile, setDocumentFile] = useState<PreparedUploadFile | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function uploadDocument() {
    setStatus(null);
    if (!workspace) {
      setStatus("Choose a workspace before uploading a payment document.");
      return;
    }
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
      tenant_id: workspace.tenantId,
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
