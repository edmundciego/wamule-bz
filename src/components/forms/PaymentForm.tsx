import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { checkDuplicateBankReference } from "../../lib/data";
import { paymentSchema } from "../../lib/schemas";
import { supabase } from "../../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../../lib/uploads";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { ErrorState } from "../ui/State";
import { UploadFileSummary } from "../uploads/UploadFileSummary";
import type { CollectionMethod, FeeType, PaymentMethod } from "../../types/database";

type PaymentValues = z.infer<typeof paymentSchema>;

const documentTypes = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"] as const;
const landTransactionTypes = ["Down Payment", "Land Installment"] as const;
const compatibleFeeTypes = ["Garbage Fee", "Road Maintenance"] as const;

export function PaymentForm({
  customerId,
  correctionOfTransactionId,
  embedded = false,
  onSuccess,
}: {
  customerId?: number;
  correctionOfTransactionId?: number | null;
  embedded?: boolean;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [documentFile, setDocumentFile] = useState<PreparedUploadFile | null>(null);
  const [documentStatus, setDocumentStatus] = useState<string | null>(null);
  const form = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      customer_id: customerId ?? 0,
      transaction_type: "Land Installment",
      collection_method: "Cash",
      document_type: "Bank Transfer Proof",
    },
  });

  const { data: customers } = useQuery({
    queryKey: ["payment-customers"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("customers").select("id, first_name, last_name").order("last_name");
      if (queryError) throw queryError;
      return data;
    },
  });
  const { data: contracts } = useQuery({
    queryKey: ["payment-contracts", form.watch("customer_id")],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("contracts")
        .select("id, customer_id, parcel_id, is_active, status")
        .eq("customer_id", Number(form.watch("customer_id")))
        .eq("is_active", true)
        .eq("status", "active");
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(form.watch("customer_id")),
  });
  const { data: paymentMethods } = useQuery({
    queryKey: ["active-payment-methods-form"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("payment_methods")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as PaymentMethod[];
    },
  });
  const { data: feeTypes } = useQuery({
    queryKey: ["active-fee-types-form"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("fee_types")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as FeeType[];
    },
  });
  const collectionOptions = buildCollectionOptions(paymentMethods);
  const transactionOptions = buildTransactionOptions(feeTypes);
  const selectedPaymentMethod = collectionOptions.find((option) => option.value === form.watch("collection_method"));

  async function onSubmit(values: PaymentValues) {
    setError(null);
    setSuccessMessage(null);
    if (values.collection_method === "Online Transfer" && values.bank_reference) {
      const duplicate = await checkDuplicateBankReference(values.bank_reference);
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
    const { data: transaction, error: insertError } = await supabase
      .from("transactions")
      .insert({
        customer_id: values.customer_id,
        contract_id: values.contract_id ? Number(values.contract_id) : null,
        amount: values.amount,
        transaction_type: values.transaction_type,
        collection_method: values.collection_method,
        bank_reference: values.bank_reference?.trim() || null,
        manual_receipt_number: values.manual_receipt_number?.trim() || null,
        receipt_date: values.receipt_date || null,
        receipt_issued_by: values.receipt_issued_by?.trim() || null,
        receipt_notes: values.receipt_notes?.trim() || null,
        notes: values.notes || null,
        status: "posted",
        reversal_of_transaction_id: correctionOfTransactionId ?? null,
        correction_notes: correctionOfTransactionId ? "Corrected replacement for a voided payment." : null,
        authorized_by: userId,
      })
      .select("id")
      .single();
    if (insertError) {
      setError(insertError.message);
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
      transaction_type: "Land Installment",
      collection_method: "Cash",
      document_type: "Bank Transfer Proof",
    });
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
              <Select {...form.register("transaction_type")}>
                {transactionOptions.map((transactionType) => (
                  <option key={transactionType}>{transactionType}</option>
                ))}
              </Select>
            </Field>
            <Field label="Contract" error={form.formState.errors.contract_id?.message}>
              <Select {...form.register("contract_id")}>
                <option value="">No contract</option>
                {contracts?.map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    Contract #{contract.id}
                  </option>
                ))}
              </Select>
            </Field>
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
          {selectedPaymentMethod?.description ? (
            <div className="crm-info-panel p-3 text-xs">
              {selectedPaymentMethod.description}
            </div>
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
      <Button disabled={form.formState.isSubmitting}>Record payment</Button>
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

function buildTransactionOptions(feeTypes: FeeType[] | undefined) {
  const feeNames = feeTypes
    ?.map((feeType) => feeType.name)
    .filter((name): name is (typeof compatibleFeeTypes)[number] => compatibleFeeTypes.includes(name as (typeof compatibleFeeTypes)[number])) ?? compatibleFeeTypes;
  return [...landTransactionTypes, ...feeNames];
}
