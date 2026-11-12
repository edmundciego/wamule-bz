import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { checkDuplicateBankReference } from "../../lib/data";
import { useWorkspaceScope } from "../auth/workspaceScopeContext";
import { workspaceScopeKey } from "../../lib/workspaceScope";
import { paymentSchema } from "../../lib/schemas";
import { buildPaymentAllocations, type PaymentAllocationTarget } from "../../lib/paymentAllocations";
import { supabase } from "../../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../../lib/uploads";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { ErrorState } from "../ui/State";
import { UploadFileSummary } from "../uploads/UploadFileSummary";
import type { CollectionMethod, FeeCharge, FeeType, Json, PaymentMethod } from "../../types/database";

type PaymentValues = z.infer<typeof paymentSchema>;

const documentTypes = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"] as const;
const landTransactionTypes = ["Down Payment", "Land Installment"] as const;
const compatibleFeeTypes = ["Garbage Fee", "Road Maintenance"] as const;
type AllocationLine = { targetKey: string; amount: string };

export function PaymentForm({
  customerId,
  correctionOfTransactionId,
  landPaymentsEnabled = true,
  embedded = false,
  onSuccess,
}: {
  customerId?: number;
  correctionOfTransactionId?: number | null;
  landPaymentsEnabled?: boolean;
  embedded?: boolean;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();
  const { workspace } = useWorkspaceScope();
  const tenantId = workspace?.tenantId ?? null;
  const scopeKey = workspaceScopeKey(workspace);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [documentFile, setDocumentFile] = useState<PreparedUploadFile | null>(null);
  const [documentStatus, setDocumentStatus] = useState<string | null>(null);
  const [allocationLines, setAllocationLines] = useState<AllocationLine[]>([{ targetKey: "", amount: "" }]);
  const form = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      customer_id: customerId ?? 0,
      transaction_type: landPaymentsEnabled ? "Land Installment" : "Garbage Fee",
      collection_method: "Cash",
      currency: "",
      unallocated_amount: 0,
      allocation_reason: "",
      document_type: "Bank Transfer Proof",
    },
  });

  const { data: customers } = useQuery({
    queryKey: ["payment-customers", scopeKey],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("customers").select("id, first_name, last_name").eq("tenant_id", tenantId!).order("last_name");
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId),
  });
  const { data: contracts } = useQuery({
    queryKey: ["payment-contracts", scopeKey, form.watch("customer_id")],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("contracts")
        .select("id, tenant_id, customer_id, parcel_id, project_id, phase_id, currency, final_purchase_price, is_active, status, projects(name), development_phases(name), parcels(lot_number)")
        .eq("customer_id", Number(form.watch("customer_id")))
        .eq("tenant_id", tenantId!)
        .eq("is_active", true)
        .eq("status", "active");
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId && workspace?.projectId && workspace.phaseId && form.watch("customer_id")),
  });
  const { data: reservations } = useQuery({
    queryKey: ["payment-reservations", scopeKey, form.watch("customer_id")],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("lot_reservations")
        .select("id, customer_id, tenant_id, project_id, phase_id, currency, status, projects(name), development_phases(name), parcels(lot_number)")
        .eq("customer_id", Number(form.watch("customer_id")))
        .eq("tenant_id", tenantId!)
        .in("status", ["reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"])
        .order("updated_at", { ascending: false });
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(tenantId && workspace?.projectId && workspace.phaseId && form.watch("customer_id")),
  });
  const { data: paymentMethods } = useQuery({
    queryKey: ["active-payment-methods-form", scopeKey],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("payment_methods")
        .select("*")
        .eq("is_active", true)
        .eq("tenant_id", tenantId!)
        .order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as PaymentMethod[];
    },
    enabled: Boolean(tenantId),
  });
  const { data: feeTypes } = useQuery({
    queryKey: ["active-fee-types-form", scopeKey],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("fee_types")
        .select("*")
        .eq("is_active", true)
        .eq("tenant_id", tenantId!)
        .order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as FeeType[];
    },
    enabled: Boolean(tenantId),
  });
  const { data: feeCharges } = useQuery({
    queryKey: ["open-fee-charges-payment-form", scopeKey, form.watch("customer_id"), form.watch("currency")],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("fee_charges")
        .select("id, tenant_id, customer_id, fee_type_id, amount, currency, scope_kind, project_id, phase_id, contract_id, reservation_id, due_date, description, status, assessed_by, assessed_at, created_at")
        .eq("tenant_id", tenantId!)
        .eq("customer_id", Number(form.watch("customer_id")))
        .eq("status", "open")
        .eq("currency", form.watch("currency"))
        .or(`and(scope_kind.eq.phase,project_id.eq.${workspace!.projectId},phase_id.eq.${workspace!.phaseId}),and(scope_kind.eq.project,project_id.eq.${workspace!.projectId},phase_id.is.null),and(scope_kind.eq.company,project_id.is.null,phase_id.is.null)`)
        .order("due_date", { ascending: true });
      if (queryError) throw queryError;
      return data as FeeCharge[];
    },
    enabled: Boolean(tenantId && workspace?.projectId && workspace.phaseId && form.watch("customer_id") && form.watch("currency")),
  });
  const collectionOptions = buildCollectionOptions(paymentMethods);
  const transactionOptions = buildTransactionOptions(feeTypes, landPaymentsEnabled);
  const selectedTransactionType = form.watch("transaction_type");
  const isLandPayment = landTransactionTypes.includes(selectedTransactionType as typeof landTransactionTypes[number]);
  const feeChargeOptions = (feeCharges ?? []).filter((charge) =>
    feeTypes?.some((feeType) => feeType.id === charge.fee_type_id && feeType.name === selectedTransactionType),
  );
  const currencyOptions = buildCurrencyOptions(paymentMethods, form.watch("collection_method"));
  const selectedPaymentMethod = paymentMethods?.find((method) =>
    (method.method_type === "Cash" ? "Cash" : "Online Transfer") === form.watch("collection_method")
    && method.currency.toUpperCase() === form.watch("currency"),
  );
  const selectedMethodDetails = selectedPaymentMethod
    ? [selectedPaymentMethod.bank_name, selectedPaymentMethod.account_name, selectedPaymentMethod.account_number, selectedPaymentMethod.instructions].filter(Boolean).join(" / ")
    : null;

  useEffect(() => {
    const currentCurrency = form.getValues("currency");
    if (!currentCurrency && currencyOptions.length) {
      form.setValue("currency", currencyOptions[0], { shouldValidate: true });
    }
  }, [currencyOptions, form]);

  async function onSubmit(values: PaymentValues) {
    setError(null);
    setSuccessMessage(null);
    if (!tenantId) {
      setError("Choose a workspace before recording a payment.");
      return;
    }
    const matchingPaymentMethod = paymentMethods?.find((method) =>
      (method.method_type === "Cash" ? "Cash" : "Online Transfer") === values.collection_method
      && method.currency.toUpperCase() === values.currency,
    );
    if (!matchingPaymentMethod) {
      setError("Choose a currency supported by an active payment method.");
      return;
    }
    const { data: scopedCustomer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", values.customer_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (customerError) {
      setError(customerError.message);
      return;
    }
    if (!scopedCustomer) {
      setError("The selected customer is outside this workspace. Select a customer from the current tenant.");
      return;
    }
    const allocationTargets: Array<{ target: PaymentAllocationTarget; amount: number }> = [];
    if (isLandPayment) {
      if (values.fee_charge_id) {
        setError("Land receipts must be allocated to contracts or reservations.");
        return;
      }
      const enteredLines = allocationLines.filter((line) => line.targetKey.trim() || line.amount.trim());
      if (enteredLines.some((line) => !line.targetKey || !line.amount.trim())) {
        setError("Complete both the obligation and amount on each allocation row.");
        return;
      }
      const targetKeys = enteredLines.map((line) => line.targetKey);
      if (new Set(targetKeys).size !== targetKeys.length) {
        setError("Each contract or reservation can appear only once on a receipt.");
        return;
      }
      const enteredUnallocatedCents = Math.round((values.unallocated_amount + Number.EPSILON) * 100);
      const targetCents = enteredLines.reduce((sum, line) => sum + Math.round((Number(line.amount) + Number.EPSILON) * 100), 0);
      const totalCents = Math.round((values.amount + Number.EPSILON) * 100);
      if (enteredUnallocatedCents + targetCents !== totalCents) {
        setError("Allocation amounts plus the unallocated remainder must equal the receipt total.");
        return;
      }
      for (const line of enteredLines) {
        const [targetKind, targetId] = line.targetKey.split(":");
        if (targetKind === "contract") {
          const { data: scopedContract, error: contractError } = await supabase
            .from("contracts")
            .select("id, customer_id, tenant_id, project_id, phase_id, currency, is_active, status")
            .eq("id", Number(targetId))
            .eq("customer_id", values.customer_id)
            .eq("tenant_id", tenantId)
            .eq("is_active", true)
            .eq("status", "active")
            .maybeSingle();
          if (contractError) {
            setError(contractError.message);
            return;
          }
          if (!scopedContract) {
            setError("The selected contract is no longer visible in this customer’s permitted workspace.");
            return;
          }
          if (scopedContract.currency !== values.currency || !scopedContract.project_id || !scopedContract.phase_id) {
            setError("Each contract allocation must match the receipt currency and have a verified project and phase.");
            return;
          }
          allocationTargets.push({
            target: {
              kind: "contract",
              id: scopedContract.id,
              currency: scopedContract.currency,
              scopeKind: "phase",
              projectId: scopedContract.project_id,
              phaseId: scopedContract.phase_id,
            },
            amount: Number(line.amount),
          });
        } else if (targetKind === "reservation") {
          const { data: scopedReservation, error: reservationError } = await supabase
            .from("lot_reservations")
            .select("id, customer_id, tenant_id, project_id, phase_id, currency, status")
            .eq("id", targetId)
            .eq("customer_id", values.customer_id)
            .eq("tenant_id", tenantId)
            .in("status", ["reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"])
            .maybeSingle();
          if (reservationError) {
            setError(reservationError.message);
            return;
          }
          if (!scopedReservation) {
            setError("The selected reservation is no longer an open sale target in this customer’s permitted workspace.");
            return;
          }
          if (scopedReservation.currency !== values.currency || !scopedReservation.project_id || !scopedReservation.phase_id) {
            setError("Each reservation allocation must match the receipt currency and have a verified project and phase.");
            return;
          }
          allocationTargets.push({
            target: {
              kind: "reservation",
              id: scopedReservation.id,
              currency: scopedReservation.currency,
              scopeKind: "phase",
              projectId: scopedReservation.project_id,
              phaseId: scopedReservation.phase_id,
            },
            amount: Number(line.amount),
          });
        } else {
          setError("Select a valid contract or reservation for each allocation row.");
          return;
        }
      }
    }
    if (values.fee_charge_id) {
      const { data: scopedFeeCharge, error: feeChargeError } = await supabase
        .from("fee_charges")
        .select("id, customer_id, tenant_id, fee_type_id, currency, scope_kind, project_id, phase_id, status")
        .eq("id", Number(values.fee_charge_id))
        .eq("tenant_id", tenantId)
        .eq("customer_id", values.customer_id)
        .eq("status", "open")
        .maybeSingle();
      if (feeChargeError) {
        setError(feeChargeError.message);
        return;
      }
      const feeScopeMatches = Boolean(scopedFeeCharge && (
        (scopedFeeCharge.scope_kind === "phase" && scopedFeeCharge.project_id === workspace!.projectId && scopedFeeCharge.phase_id === workspace!.phaseId)
        || (scopedFeeCharge.scope_kind === "project" && scopedFeeCharge.project_id === workspace!.projectId && scopedFeeCharge.phase_id === null)
        || (scopedFeeCharge.scope_kind === "company" && scopedFeeCharge.project_id === null && scopedFeeCharge.phase_id === null)
      ));
      if (!scopedFeeCharge || !feeScopeMatches || scopedFeeCharge.currency !== values.currency) {
        setError("The selected fee charge is not open in this customer, phase and currency.");
        return;
      }
      allocationTargets.push({
        target: {
          kind: "fee_charge",
          id: scopedFeeCharge.id,
          currency: scopedFeeCharge.currency,
          scopeKind: scopedFeeCharge.scope_kind,
          projectId: scopedFeeCharge.project_id,
          phaseId: scopedFeeCharge.phase_id,
        },
        amount: values.amount - values.unallocated_amount,
      });
    }
    if (values.collection_method === "Online Transfer" && values.bank_reference) {
      const duplicate = await checkDuplicateBankReference(values.bank_reference, tenantId ?? "");
      if (duplicate) {
        setError("That bank reference has already been recorded.");
        return;
      }
    }
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (!userId) {
      setError("Your session has expired. Sign in again.");
      return;
    }
    let allocations: ReturnType<typeof buildPaymentAllocations>;
    try {
      allocations = buildPaymentAllocations({
        totalAmount: values.amount,
        currency: values.currency,
        allocations: allocationTargets,
        unallocatedReason: values.unallocated_amount > 0 || !allocationTargets.length ? values.allocation_reason : null,
      });
    } catch (allocationError) {
      setError((allocationError as Error).message);
      return;
    }
    const { data: transaction, error: insertError } = await supabase.rpc("record_payment_with_allocations_v1", {
      p_customer_id: values.customer_id,
      p_amount: values.amount,
      p_currency: values.currency,
      p_transaction_type: values.transaction_type,
      p_collection_method: values.collection_method,
      p_bank_reference: values.bank_reference?.trim() || null,
      p_manual_receipt_number: values.manual_receipt_number?.trim() || null,
      p_receipt_date: values.receipt_date || null,
      p_receipt_issued_by: values.receipt_issued_by?.trim() || null,
      p_receipt_notes: values.receipt_notes?.trim() || null,
      p_notes: values.notes || null,
      p_reversal_of_transaction_id: correctionOfTransactionId ?? null,
      p_allocations: allocations as unknown as Json,
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    if (!transaction) {
      setError("The payment operation returned no receipt. Check the payment list before retrying.");
      return;
    }

    if (documentFile) {
      setDocumentStatus("Uploading document...");
      const safeName = documentFile.uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `${values.customer_id}/${transaction.id}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from("payment-documents")
        .upload(filePath, documentFile.uploadFile, { upsert: false });
      if (uploadError) {
        setError(`Payment was recorded, but document upload failed: ${uploadError.message}`);
        await queryClient.invalidateQueries();
        return;
      }

      const { error: documentError } = await supabase.from("payment_documents").insert({
        tenant_id: tenantId,
        transaction_id: transaction.id,
        customer_id: values.customer_id,
        document_type: values.document_type || "Other",
        file_path: filePath,
        original_file_name: documentFile.originalFile.name,
        uploaded_by: userId,
      });
      if (documentError) {
        setError(`Payment was recorded, but document record failed: ${documentError.message}`);
        await queryClient.invalidateQueries();
        return;
      }
    }

    setSuccessMessage("Payment recorded.");
    setDocumentFile(null);
    setDocumentStatus(null);
    form.reset({
      customer_id: customerId ?? 0,
      transaction_type: landPaymentsEnabled ? "Land Installment" : "Garbage Fee",
      collection_method: "Cash",
      currency: currencyOptions[0] ?? "",
      unallocated_amount: 0,
      allocation_reason: "",
      document_type: "Bank Transfer Proof",
    });
    setAllocationLines([{ targetKey: "", amount: "" }]);
    await queryClient.invalidateQueries();
    onSuccess?.();
  }

  async function handleDocumentChange(file: File | undefined) {
    setDocumentFile(null);
    setDocumentStatus(null);
    if (!file) return;
    setDocumentStatus("Preparing file...");
    try {
      const prepared = await prepareUploadFile(file, "payment-document");
      setDocumentFile(prepared);
      setDocumentStatus(prepared.wasCompressed ? "Image compressed and ready to upload." : "File ready to upload.");
    } catch (fileError) {
      setDocumentStatus((fileError as Error).message);
    }
  }

  const formContent = (
    <form className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          {error ? <ErrorState message={error} /> : null}
          {correctionOfTransactionId ? (
            <div className="crm-warning-panel p-3 text-sm">
              Recording a corrected replacement for voided payment #{correctionOfTransactionId}. The original payment remains in history.
            </div>
          ) : null}
          {successMessage ? (
            <div className="crm-success-panel p-3 text-sm">
              {successMessage}
            </div>
          ) : null}
          <Field label="Customer" error={form.formState.errors.customer_id?.message}>
            <Select {...form.register("customer_id")} disabled={Boolean(customerId)}>
              <option value="">Select customer</option>
              {customers?.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.first_name} {customer.last_name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Transaction type" error={form.formState.errors.transaction_type?.message}>
              <Select
                {...form.register("transaction_type")}
                onChange={(event) => {
                  form.setValue("transaction_type", event.target.value as PaymentValues["transaction_type"], { shouldValidate: true });
                  form.setValue("fee_charge_id", "");
                }}
              >
                {transactionOptions.map((transactionType) => (
                  <option key={transactionType}>{transactionType}</option>
                ))}
              </Select>
            </Field>
            {isLandPayment ? (
              <Field label="Receipt allocation">
                <div className="grid gap-2">
                  {allocationLines.map((line, index) => (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]" key={`allocation-${index}`}>
                      <Select
                        value={line.targetKey}
                        onChange={(event) => setAllocationLines((current) => current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, targetKey: event.target.value } : item,
                        ))}
                      >
                        <option value="">Select a permitted contract or reservation</option>
                        <optgroup label="Contracts">
                          {contracts?.filter((contract) => contract.currency === form.watch("currency")).map((contract) => (
                            <option key={`contract-${contract.id}`} value={`contract:${contract.id}`}>
                              Contract #{contract.id} · {scopeOptionLabel(contract.projects, contract.development_phases, contract.project_id, contract.phase_id)} · {contract.currency}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Reservations">
                          {reservations?.filter((reservation) => reservation.currency === form.watch("currency")).map((reservation) => (
                            <option key={`reservation-${reservation.id}`} value={`reservation:${reservation.id}`}>
                              Reservation #{reservation.id} · {scopeOptionLabel(reservation.projects, reservation.development_phases, reservation.project_id, reservation.phase_id)} · {reservation.currency}
                            </option>
                          ))}
                        </optgroup>
                      </Select>
                      <Input
                        aria-label={`Allocation ${index + 1} amount`}
                        type="number"
                        min="0.01"
                        step="0.01"
                        inputMode="decimal"
                        placeholder="Amount"
                        value={line.amount}
                        onChange={(event) => setAllocationLines((current) => current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, amount: event.target.value } : item,
                        ))}
                      />
                      {allocationLines.length > 1 ? (
                        <Button type="button" variant="secondary" onClick={() => setAllocationLines((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2">
                    <Button type="button" variant="secondary" onClick={() => setAllocationLines((current) => [...current, { targetKey: "", amount: "" }])}>
                      Add allocation
                    </Button>
                    <span className="text-xs text-muted-foreground">Only obligations permitted by your current membership appear here.</span>
                  </div>
                </div>
              </Field>
            ) : (
              <Field label="Assessed fee obligation" error={form.formState.errors.fee_charge_id?.message}>
                <Select {...form.register("fee_charge_id")}>
                  <option value="">Select an open assessed fee</option>
                  {feeChargeOptions.map((charge) => (
                    <option key={charge.id} value={charge.id}>
                      Fee charge #{charge.id} · {charge.description} · {charge.amount} {charge.currency}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount" error={form.formState.errors.amount?.message}>
              <Input type="number" min="0" step="0.01" {...form.register("amount")} />
            </Field>
            <Field label="Collection method" error={form.formState.errors.collection_method?.message}>
              <Select {...form.register("collection_method")}>
                {collectionOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Receipt currency" error={form.formState.errors.currency?.message}>
            <Select {...form.register("currency")} disabled={!currencyOptions.length}>
              <option value="">Select a configured currency</option>
              {currencyOptions.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </Select>
            {!currencyOptions.length ? <p className="mt-1 text-xs text-muted-foreground">Configure an active payment method with a currency before recording receipts.</p> : null}
          </Field>
          {selectedMethodDetails ? (
            <div className="crm-info-panel p-3 text-xs">
              {selectedMethodDetails}
            </div>
          ) : null}
          <Field label="Amount left unallocated for review" error={form.formState.errors.unallocated_amount?.message}>
            <Input type="number" min="0" step="0.01" {...form.register("unallocated_amount")} />
            <p className="mt-1 text-xs text-muted-foreground">The unallocated remainder must match the difference between the receipt total and its allocation rows. Unallocated amounts stay outside phase balances.</p>
          </Field>
          {Number(form.watch("unallocated_amount")) > 0 || (isLandPayment ? !allocationLines.some((line) => line.targetKey.trim()) : !form.watch("fee_charge_id")) ? (
            <Field label="Reason for unallocated amount" error={form.formState.errors.allocation_reason?.message}>
              <Textarea {...form.register("allocation_reason")} />
            </Field>
          ) : null}
          <Field label="Bank reference" error={form.formState.errors.bank_reference?.message}>
            <Input {...form.register("bank_reference")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Manual receipt number">
              <Input {...form.register("manual_receipt_number")} />
            </Field>
            <Field label="Receipt date">
              <Input type="date" {...form.register("receipt_date")} />
            </Field>
          </div>
          <Field label="Receipt issued by">
            <Input {...form.register("receipt_issued_by")} />
          </Field>
          <Field label="Receipt notes">
            <Textarea {...form.register("receipt_notes")} />
          </Field>
          <Field label="Document type">
            <Select {...form.register("document_type")}>
              {documentTypes.map((documentType) => (
                <option key={documentType}>{documentType}</option>
              ))}
            </Select>
          </Field>
          <Field label="Optional payment document">
            <div className="v2-workflow-panel grid gap-2 p-3">
              <Input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(event) => void handleDocumentChange(event.target.files?.[0])}
              />
              <p className="text-xs font-normal text-muted-foreground">
                Upload a bank proof, receipt photo, signed note, or supporting PDF.
              </p>
              <UploadFileSummary file={documentFile} status={documentStatus} />
            </div>
          </Field>
          <Field label="Notes">
            <Textarea {...form.register("notes")} />
          </Field>
      <Button disabled={form.formState.isSubmitting || !paymentMethods?.length}>Record payment</Button>
    </form>
  );

  if (embedded) {
    return formContent;
  }

  return (
    <Card className="v2-ledger-panel">
      <CardHeader>
        <CardTitle>Record Payment</CardTitle>
      </CardHeader>
      <CardContent>
        {formContent}
      </CardContent>
    </Card>
  );
}

function buildCollectionOptions(methods: PaymentMethod[] | undefined): Array<{ value: CollectionMethod; label: string; description: string | null }> {
  if (!methods?.length) {
    return [
      { value: "Cash", label: "Cash", description: null },
      { value: "Online Transfer", label: "Online Transfer", description: null },
    ];
  }

  const options = new Map<CollectionMethod, { value: CollectionMethod; label: string; description: string | null }>();
  methods.forEach((method) => {
    const value: CollectionMethod = method.method_type === "Cash" ? "Cash" : "Online Transfer";
    if (options.has(value)) return;
    const bankDetails = [method.bank_name, method.account_name, method.account_number].filter(Boolean).join(" / ");
    options.set(value, {
      value,
      label: method.method_type === "Cash" ? method.name : method.name || "Bank Transfer",
      description: [bankDetails, method.instructions].filter(Boolean).join(" - ") || null,
    });
  });
  return Array.from(options.values());
}

function buildCurrencyOptions(methods: PaymentMethod[] | undefined, collectionMethod: CollectionMethod) {
  return Array.from(new Set((methods ?? [])
    .filter((method) => (method.method_type === "Cash" ? "Cash" : "Online Transfer") === collectionMethod)
    .map((method) => method.currency.toUpperCase())
    .filter((currency) => /^[A-Z]{3}$/.test(currency))));
}

function buildTransactionOptions(feeTypes: FeeType[] | undefined, landPaymentsEnabled = true) {
  const feeNames = feeTypes
    ?.map((feeType) => feeType.name)
    .filter((name): name is (typeof compatibleFeeTypes)[number] => compatibleFeeTypes.includes(name as (typeof compatibleFeeTypes)[number])) ?? compatibleFeeTypes;
  return landPaymentsEnabled ? [...landTransactionTypes, ...feeNames] : feeNames;
}

function scopeOptionLabel(
  projectRelation: unknown,
  phaseRelation: unknown,
  projectId: string | null,
  phaseId: string | null,
) {
  const projectName = relationValue(projectRelation, "name");
  const phaseName = relationValue(phaseRelation, "name");
  return `Project ${projectName ?? projectId ?? "unscoped"} · Phase ${phaseName ?? phaseId ?? "unscoped"}`;
}

function relationValue(value: unknown, key: string): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || !(key in candidate)) return null;
  const result = (candidate as Record<string, unknown>)[key];
  return typeof result === "string" && result.trim() ? result : null;
}
