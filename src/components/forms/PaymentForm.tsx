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

type PaymentValues = z.infer<typeof paymentSchema>;

const documentTypes = ["Bank Transfer Proof", "Manual Receipt Photo", "Signed Payment Note", "Other"] as const;

export function PaymentForm({
  customerId,
  embedded = false,
  onSuccess,
}: {
  customerId?: number;
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
        .select("id, customer_id, parcel_id, is_active")
        .eq("customer_id", Number(form.watch("customer_id")))
        .eq("is_active", true);
      if (queryError) throw queryError;
      return data;
    },
    enabled: Boolean(form.watch("customer_id")),
  });

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
          {successMessage ? (
            <div className="rounded-md border border-sage/35 bg-sage/15 p-3 text-sm">
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
                <option>Down Payment</option>
                <option>Land Installment</option>
                <option>Garbage Fee</option>
                <option>Road Maintenance</option>
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
                <option>Cash</option>
                <option>Online Transfer</option>
              </Select>
            </Field>
          </div>
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
            <div className="grid gap-2 rounded-md border bg-ivory/40 p-3">
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
    <Card>
      <CardHeader>
        <CardTitle>Record Payment</CardTitle>
      </CardHeader>
      <CardContent>
        {formContent}
      </CardContent>
    </Card>
  );
}
