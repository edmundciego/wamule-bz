import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { contractSchema } from "../../lib/schemas";
import { supabase } from "../../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../../lib/uploads";
import { money } from "../../lib/utils";
import { Button } from "../ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { ErrorState } from "../ui/State";
import type { InstallmentPlan } from "../../types/database";
import { UploadFileSummary } from "../uploads/UploadFileSummary";

type ContractValues = z.infer<typeof contractSchema>;

const standardPurchasePrice = 25000;
const reservationFee = 2500;
const fallbackPlans: InstallmentPlan[] = [
  {
    id: -1,
    name: "Installment Plan - 60 months",
    description: "$2,500 reservation fee, $375.00 monthly",
    reservation_fee: reservationFee,
    initial_deposit: reservationFee,
    final_purchase_price: standardPurchasePrice,
    term_months: 60,
    monthly_payment: 375,
    is_active: true,
    sort_order: 30,
    created_at: "",
    updated_at: "",
  },
];

export function ContractForm({
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
  const [file, setFile] = useState<PreparedUploadFile | null>(null);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [paymentPlanId, setPaymentPlanId] = useState<number | null>(null);
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
  const { data: configuredPlans } = useQuery({
    queryKey: ["active-installment-plans-contract"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("installment_plans")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as InstallmentPlan[];
    },
  });
  const paymentPlans = configuredPlans?.length ? configuredPlans : fallbackPlans;
  const selectedPlan = paymentPlans.find((plan) => plan.id === paymentPlanId) ?? paymentPlans[0];
  const isCustomAgreement = /other|custom/i.test(selectedPlan?.name ?? "");

  useEffect(() => {
    if (!selectedPlan) return;
    if (paymentPlanId === null) {
      setPaymentPlanId(selectedPlan.id);
      if (!/other|custom/i.test(selectedPlan.name)) {
        form.setValue("final_purchase_price", Number(selectedPlan.final_purchase_price), { shouldDirty: true, shouldValidate: true });
        form.setValue("initial_deposit", Number(selectedPlan.initial_deposit || selectedPlan.reservation_fee), { shouldDirty: true, shouldValidate: true });
        form.setValue("term_months", Number(selectedPlan.term_months), { shouldDirty: true, shouldValidate: true });
      }
    }
  }, [form, paymentPlanId, selectedPlan]);

  const { data: customers } = useQuery({
    queryKey: ["customers-options"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("customers").select("id, first_name, last_name").order("last_name");
      if (queryError) throw queryError;
      return data;
    },
  });
  const { data: parcels } = useQuery({
    queryKey: ["contract-customer-authorization", form.watch("customer_id")],
    queryFn: async () => {
      const customerIdValue = Number(form.watch("customer_id"));
      const { data: customer, error: customerError } = await supabase
        .from("customers")
        .select("application_id, applications(status, parcel_id, parcels(id, lot_number, status))")
        .eq("id", customerIdValue)
        .maybeSingle();
      if (customerError) throw customerError;
      if (!customer) return null;
      const { data: reservations, error: reservationError } = await supabase
        .from("lot_reservations")
        .select("id, parcel_id, status, updated_at, parcels(id, lot_number, status)")
        .eq("customer_id", customerIdValue)
        .in("status", ["reserved", "deposit_pending", "deposit_submitted", "deposit_confirmed"])
        .order("updated_at", { ascending: false })
        .limit(1);
      if (reservationError) throw reservationError;
      const reservation = reservations?.[0] ?? null;
      const reservationParcel = Array.isArray(reservation?.parcels) ? reservation.parcels[0] : reservation?.parcels;
      if (reservation && reservationParcel) return { parcel: reservationParcel, source: "Active Reservation" };
      const application = (Array.isArray(customer.applications) ? customer.applications[0] : customer.applications) as unknown as { status: string; parcel_id: number | null; parcels?: { id: number; lot_number: string; status: string } | Array<{ id: number; lot_number: string; status: string }> | null } | null;
      const applicationParcel = Array.isArray(application?.parcels) ? application.parcels[0] : application?.parcels;
      if (application?.status === "Approved" && application.parcel_id && applicationParcel) {
        return { parcel: applicationParcel, source: "Approved Application" };
      }
      return null;
    },
    enabled: Boolean(form.watch("customer_id")),
  });

  useEffect(() => {
    if (parcels?.parcel?.id) {
      form.setValue("parcel_id", parcels.parcel.id, { shouldValidate: true });
    } else {
      form.setValue("parcel_id", 0, { shouldValidate: true });
    }
  }, [form, parcels]);

  function applyPaymentPlan(plan: InstallmentPlan) {
    if (/other|custom/i.test(plan.name)) return;
    form.setValue("final_purchase_price", Number(plan.final_purchase_price), { shouldDirty: true, shouldValidate: true });
    form.setValue("initial_deposit", Number(plan.initial_deposit || plan.reservation_fee), { shouldDirty: true, shouldValidate: true });
    form.setValue("term_months", Number(plan.term_months), { shouldDirty: true, shouldValidate: true });
  }

  function handlePaymentPlanChange(nextPlanId: number) {
    setPaymentPlanId(nextPlanId);
    const plan = paymentPlans.find((option) => option.id === nextPlanId);
    if (plan) applyPaymentPlan(plan);
  }

  async function onSubmit(values: ContractValues) {
    setError(null);
    let signed_contract_file_path: string | null = null;
    if (file) {
      setFileStatus("Uploading signed contract...");
      const safeName = file.uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${values.customer_id}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from("contracts").upload(path, file.uploadFile);
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
    setPaymentPlanId(paymentPlans[0]?.id ?? null);
    setFile(null);
    setFileStatus(null);
    await queryClient.invalidateQueries();
    onSuccess?.();
  }

  async function handleContractFileChange(selectedFile: File | undefined) {
    setFile(null);
    setFileStatus(null);
    if (!selectedFile) return;
    setFileStatus("Preparing file...");
    try {
      const prepared = await prepareUploadFile(selectedFile, "signed-contract");
      setFile(prepared);
      setFileStatus(prepared.wasCompressed ? "Image compressed and ready to upload." : "File ready to upload.");
    } catch (fileError) {
      setFileStatus((fileError as Error).message);
    }
  }

  const formContent = (
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
          <Field label="Authorized lot" error={form.formState.errors.parcel_id?.message}>
            <Input
              readOnly
              value={parcels?.parcel ? `Lot ${parcels.parcel.lot_number} (${parcels.parcel.status}) — ${parcels.source}` : "No authorized lot"}
            />
            <input type="hidden" {...form.register("parcel_id")} />
            <p className="mt-1 text-xs text-muted-foreground">
              A contract requires an active reservation for this customer, or the lot on the customer’s approved application.
            </p>
          </Field>
          <Field label="Payment plan">
            <Select value={paymentPlanId ?? ""} onChange={(event) => handlePaymentPlanChange(Number(event.target.value))}>
              {paymentPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="crm-info-panel p-3 text-sm">
            <p className="font-medium text-primary">{selectedPlan?.description ?? "Use configured payment terms."}</p>
            {!isCustomAgreement ? (
              <p className="mt-1">
                This plan uses a {money(Number(selectedPlan?.reservation_fee ?? 0))} reservation fee and a listed monthly payment of {money(Number(selectedPlan?.monthly_payment ?? 0))}.
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
            <div className="v2-workflow-panel grid gap-2 p-3">
              <Input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => void handleContractFileChange(event.target.files?.[0])} />
              <p className="text-xs font-normal text-muted-foreground">
                PDFs must be 20 MB or smaller. Images are compressed before upload.
              </p>
              <UploadFileSummary file={file} status={fileStatus} />
            </div>
          </Field>
          <div className="v2-ledger-row text-sm">
            Calculated monthly payment: <strong>{money(monthly)}</strong>
            {!isCustomAgreement && selectedPlan?.monthly_payment && Math.abs(monthly - Number(selectedPlan.monthly_payment)) >= 0.01 ? (
              <span className="mt-1 block text-muted-foreground">
                Listed plan amount: {money(Number(selectedPlan.monthly_payment))} monthly.
              </span>
            ) : null}
          </div>
      <Button disabled={form.formState.isSubmitting || !parcels?.parcel}>Create contract</Button>
    </form>
  );

  if (embedded) {
    return formContent;
  }

  return (
    <Card className="v2-workflow-panel">
      <CardHeader>
        <CardTitle>Create Contract</CardTitle>
      </CardHeader>
      <CardContent>
        {formContent}
      </CardContent>
    </Card>
  );
}
