import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import type { z } from "zod";
import { checkDuplicateBankReference } from "../../lib/data";
import { paymentSchema } from "../../lib/schemas";
import { supabase } from "../../lib/supabase";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Field, Input, Select, Textarea } from "../ui/Field";
import { ErrorState } from "../ui/State";

type PaymentValues = z.infer<typeof paymentSchema>;

export function PaymentForm({ customerId }: { customerId?: number }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [createdTransactionId, setCreatedTransactionId] = useState<number | null>(null);
  const form = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      customer_id: customerId ?? 0,
      transaction_type: "Land Installment",
      collection_method: "Cash",
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
    setCreatedTransactionId(null);
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
        notes: values.notes || null,
        authorized_by: userId,
      })
      .select("id")
      .single();
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setCreatedTransactionId(transaction.id);
    form.reset({ customer_id: customerId ?? 0, transaction_type: "Land Installment", collection_method: "Cash" });
    await queryClient.invalidateQueries();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record Payment</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          {error ? <ErrorState message={error} /> : null}
          {createdTransactionId ? (
            <div className="rounded-md border border-sage/35 bg-sage/15 p-3 text-sm">
              Payment recorded.{" "}
              <Link className="font-medium text-primary hover:text-copper" to={`/documents/receipt/${createdTransactionId}`}>
                View receipt
              </Link>
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
          <Field label="Notes">
            <Textarea {...form.register("notes")} />
          </Field>
          <Button disabled={form.formState.isSubmitting}>Record payment</Button>
        </form>
      </CardContent>
    </Card>
  );
}
