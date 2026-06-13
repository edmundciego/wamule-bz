import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { contractSchema } from "../../lib/schemas";
import { supabase } from "../../lib/supabase";
import { money } from "../../lib/utils";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { ErrorState } from "../ui/State";

type ContractValues = z.infer<typeof contractSchema>;

type PaymentPlanId = "installment_36" | "installment_48" | "installment_60" | "other";

const reservationFee = 2500;
const standardPurchasePrice = 25000;
const paymentPlans: Record<
  PaymentPlanId,
  {
    label: string;
    description: string;
    finalPurchasePrice?: number;
    initialDeposit?: number;
    termMonths?: number;
    quotedMonthly?: number;
  }
> = {
  installment_36: {
    label: "Installment Plan - 36 months",
    description: "$2,500 reservation fee, $625.00 monthly",
    finalPurchasePrice: standardPurchasePrice,
    initialDeposit: reservationFee,
    termMonths: 36,
    quotedMonthly: 625,
  },
  installment_48: {
    label: "Installment Plan - 48 months",
    description: "$2,500 reservation fee, $470.00 monthly",
    finalPurchasePrice: standardPurchasePrice,
    initialDeposit: reservationFee,
    termMonths: 48,
    quotedMonthly: 470,
  },
  installment_60: {
    label: "Installment Plan - 60 months",
    description: "$2,500 reservation fee, $375.00 monthly",
    finalPurchasePrice: standardPurchasePrice,
    initialDeposit: reservationFee,
    termMonths: 60,
    quotedMonthly: 375,
  },
  other: {
    label: "Other agreement",
    description: "Use custom deposit, price, and term",
  },
};

export function ContractForm({ customerId }: { customerId?: number }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [paymentPlan, setPaymentPlan] = useState<PaymentPlanId>("installment_60");
  const form = useForm<ContractValues>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      customer_id: customerId ?? 0,
      final_purchase_price: standardPurchasePrice,
      term_months: 60,
      start_date: new Date().toISOString().slice(0, 10),
      payment_due_day: 1,
      initial_deposit: reservationFee,
    },
  });
  const finalPrice = Number(form.watch("final_purchase_price") || 0);
  const deposit = Number(form.watch("initial_deposit") || 0);
  const term = Number(form.watch("term_months") || 1);
  const monthly = term > 0 ? (finalPrice - deposit) / term : 0;
  const selectedPlan = paymentPlans[paymentPlan];
  const isCustomAgreement = paymentPlan === "other";

  const { data: customers } = useQuery({
    queryKey: ["customers-options"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("customers").select("id, first_name, last_name").order("last_name");
      if (queryError) throw queryError;
      return data;
    },
  });
  const { data: parcels } = useQuery({
    queryKey: ["available-parcels-options"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("parcels")
        .select("id, lot_number, status")
        .in("status", ["Available", "Reserved"])
        .order("lot_number");
      if (queryError) throw queryError;
      return data;
    },
  });

  function handlePaymentPlanChange(planId: PaymentPlanId) {
    setPaymentPlan(planId);
    const plan = paymentPlans[planId];
    if (!plan.finalPurchasePrice || !plan.initialDeposit || !plan.termMonths) return;
    form.setValue("final_purchase_price", plan.finalPurchasePrice, { shouldDirty: true, shouldValidate: true });
    form.setValue("initial_deposit", plan.initialDeposit, { shouldDirty: true, shouldValidate: true });
    form.setValue("term_months", plan.termMonths, { shouldDirty: true, shouldValidate: true });
  }

  async function onSubmit(values: ContractValues) {
    setError(null);
    let signed_contract_file_path: string | null = null;
    if (file) {
      const path = `${values.customer_id}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from("contracts").upload(path, file);
      if (uploadError) {
        setError(uploadError.message);
        return;
      }
      signed_contract_file_path = path;
    }
    const { error: insertError } = await supabase.from("contracts").insert({
      ...values,
      signed_contract_file_path,
      is_active: true,
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    form.reset({
      customer_id: customerId ?? 0,
      final_purchase_price: standardPurchasePrice,
      term_months: 60,
      start_date: new Date().toISOString().slice(0, 10),
      payment_due_day: 1,
      initial_deposit: reservationFee,
    });
    setPaymentPlan("installment_60");
    setFile(null);
    await queryClient.invalidateQueries();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Contract</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          {error ? <ErrorState message={error} /> : null}
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
          <Field label="Parcel" error={form.formState.errors.parcel_id?.message}>
            <Select {...form.register("parcel_id")}>
              <option value="">Select lot</option>
              {parcels?.map((parcel) => (
                <option key={parcel.id} value={parcel.id}>
                  Lot {parcel.lot_number} ({parcel.status})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment plan">
            <Select value={paymentPlan} onChange={(event) => handlePaymentPlanChange(event.target.value as PaymentPlanId)}>
              {Object.entries(paymentPlans).map(([value, plan]) => (
                <option key={value} value={value}>
                  {plan.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="rounded-md border bg-sage/10 p-3 text-sm text-muted-foreground">
            <p className="font-medium text-primary">{selectedPlan.description}</p>
            {!isCustomAgreement ? (
              <p className="mt-1">
                Standard plans use a {money(reservationFee)} reservation fee per lot. Choose Other agreement for custom terms.
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Final purchase price" error={form.formState.errors.final_purchase_price?.message}>
              <Input type="number" min="0" step="0.01" readOnly={!isCustomAgreement} {...form.register("final_purchase_price")} />
            </Field>
            <Field label="Initial deposit" error={form.formState.errors.initial_deposit?.message}>
              <Input type="number" min="0" step="0.01" readOnly={!isCustomAgreement} {...form.register("initial_deposit")} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Term months" error={form.formState.errors.term_months?.message}>
              <Input type="number" min="1" max="60" readOnly={!isCustomAgreement} {...form.register("term_months")} />
            </Field>
            <Field label="Start date" error={form.formState.errors.start_date?.message}>
              <Input type="date" {...form.register("start_date")} />
            </Field>
            <Field label="Due day" error={form.formState.errors.payment_due_day?.message}>
              <Input type="number" min="1" max="31" {...form.register("payment_due_day")} />
            </Field>
          </div>
          <Field label="Signed contract upload">
            <Input type="file" accept="application/pdf,image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </Field>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            Calculated monthly payment: <strong>{money(monthly)}</strong>
            {!isCustomAgreement && selectedPlan.quotedMonthly && Math.abs(monthly - selectedPlan.quotedMonthly) >= 0.01 ? (
              <span className="mt-1 block text-muted-foreground">
                Listed plan amount: {money(selectedPlan.quotedMonthly)} monthly.
              </span>
            ) : null}
          </div>
          <Button disabled={form.formState.isSubmitting}>Create contract</Button>
        </form>
      </CardContent>
    </Card>
  );
}
