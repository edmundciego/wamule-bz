import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Field, Input, Select, Textarea } from "../components/ui/Field";
import { ErrorState, LoadingState } from "../components/ui/State";
import { UploadFileSummary } from "../components/uploads/UploadFileSummary";
import { supabase } from "../lib/supabase";
import { prepareUploadFile, type PreparedUploadFile } from "../lib/uploads";
import { cn, money } from "../lib/utils";
import type {
  AiSetting,
  AppRole,
  BusinessSetting,
  BusinessSettingKey,
  FeeFrequency,
  FeeType,
  InstallmentPlan,
  LotSize,
  PaymentMethod,
  PaymentMethodType,
} from "../types/database";

const roles: AppRole[] = ["Super Admin", "Admin", "Staff", "Read Only"];
const paymentMethodTypes: PaymentMethodType[] = ["Cash", "Bank Transfer", "Other"];
const feeFrequencies: FeeFrequency[] = ["One-Time", "Monthly", "Yearly", "As Needed"];
const settingsSections = ["Company Profile", "Payment Methods", "Installment Plans", "Lot Sizes", "Fee Types", "CRM Workflow Guide", "AI Settings", "Users & Roles"] as const;

type SettingsSection = (typeof settingsSections)[number];
type DraftPaymentMethod = PaymentMethod & { isNew?: boolean };
type DraftInstallmentPlan = InstallmentPlan & { isNew?: boolean };
type DraftLotSize = LotSize & { isNew?: boolean };
type DraftFeeType = FeeType & { isNew?: boolean };

type CompanyProfileSettings = {
  company_name: string;
  logo_url: string;
  contact_email: string;
  phone_number: string;
  website: string;
  location_address: string;
  short_description: string;
};

type PublicApplicationSettings = {
  applications_open: boolean;
  public_notice_text: string;
  application_acknowledgment_text: string;
  show_lot_prices_publicly: boolean;
  show_available_lot_count_publicly: boolean;
  default_confirmation_message: string;
};

const defaultCompany: CompanyProfileSettings = {
  company_name: "Wamuale Development",
  logo_url: "/favicon/android-chrome-192x192.png",
  contact_email: "",
  phone_number: "",
  website: "",
  location_address: "Mile 3, Hummingbird Highway, Dangriga Town, Belize",
  short_description: "Private subdivision land development in Dangriga Town, Belize.",
};

const defaultApplication: PublicApplicationSettings = {
  applications_open: true,
  public_notice_text:
    "Submission of this application is solely a request to be considered for the purchase of a lot within Wamuale Development.",
  application_acknowledgment_text:
    "By signing this application, I acknowledge and understand that submission does not guarantee approval or allocation of a lot.",
  show_lot_prices_publicly: true,
  show_available_lot_count_publicly: true,
  default_confirmation_message: "Application submitted. A Wamuale Development representative will contact you after review.",
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SettingsSection>("Company Profile");
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [company, setCompany] = useState<CompanyProfileSettings>(defaultCompany);
  const [application, setApplication] = useState<PublicApplicationSettings>(defaultApplication);
  const [logoFile, setLogoFile] = useState<PreparedUploadFile | null>(null);
  const [logoStatus, setLogoStatus] = useState<string | null>(null);
  const [paymentMethodsDraft, setPaymentMethodsDraft] = useState<DraftPaymentMethod[]>([]);
  const [plansDraft, setPlansDraft] = useState<DraftInstallmentPlan[]>([]);
  const [lotSizesDraft, setLotSizesDraft] = useState<DraftLotSize[]>([]);
  const [feeTypesDraft, setFeeTypesDraft] = useState<DraftFeeType[]>([]);
  const [aiDraft, setAiDraft] = useState<AiSetting | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<AppRole>("Staff");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userMessage, setUserMessage] = useState<string | null>(null);

  const { data: sessionData } = useQuery({
    queryKey: ["settings-session"],
    queryFn: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session;
    },
  });

  const { data: currentProfile } = useQuery({
    queryKey: ["settings-current-profile", sessionData?.user.id],
    queryFn: async () => {
      const { data, error: profileError } = await supabase
        .from("admin_profiles")
        .select("role")
        .eq("user_id", sessionData?.user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      return data;
    },
    enabled: Boolean(sessionData?.user.id),
  });

  const isSuperAdmin = currentProfile?.role === "Super Admin";
  const isAdmin = currentProfile?.role === "Super Admin" || currentProfile?.role === "Admin";
  const canManageConfig = isAdmin;
  const canManageUsers = isSuperAdmin;
  const canManageAi = isSuperAdmin;

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["business-settings"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("business_settings").select("*");
      if (queryError) throw queryError;
      return data as BusinessSetting[];
    },
  });

  const { data: paymentMethods, isLoading: paymentMethodsLoading } = useQuery({
    queryKey: ["payment-methods-admin"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("payment_methods").select("*").order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as PaymentMethod[];
    },
  });

  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: ["installment-plans-admin"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("installment_plans").select("*").order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as InstallmentPlan[];
    },
  });

  const { data: lotSizes, isLoading: lotSizesLoading } = useQuery({
    queryKey: ["lot-sizes-admin"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("lot_sizes").select("*").order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as LotSize[];
    },
  });

  const { data: feeTypes, isLoading: feeTypesLoading } = useQuery({
    queryKey: ["fee-types-admin"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("fee_types").select("*").order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as FeeType[];
    },
  });

  const { data: aiSettings, isLoading: aiLoading } = useQuery({
    queryKey: ["ai-settings-admin"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("ai_settings").select("*").order("id", { ascending: true }).limit(1).maybeSingle();
      if (queryError) throw queryError;
      return data as AiSetting | null;
    },
  });

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("admin_profiles").select("*").order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return data;
    },
  });

  useEffect(() => {
    if (!settings) return;
    setCompany({ ...defaultCompany, ...settingValue<CompanyProfileSettings>(settings, "company_profile") });
    setApplication({ ...defaultApplication, ...settingValue<PublicApplicationSettings>(settings, "public_application") });
  }, [settings]);

  useEffect(() => {
    if (paymentMethods) setPaymentMethodsDraft(paymentMethods);
  }, [paymentMethods]);

  useEffect(() => {
    if (plans) setPlansDraft(plans);
  }, [plans]);

  useEffect(() => {
    if (lotSizes) setLotSizesDraft(lotSizes);
  }, [lotSizes]);

  useEffect(() => {
    if (feeTypes) setFeeTypesDraft(feeTypes);
  }, [feeTypes]);

  useEffect(() => {
    if (aiSettings) setAiDraft(aiSettings);
  }, [aiSettings]);

  async function saveBusinessSetting<T extends Record<string, unknown>>(key: BusinessSettingKey, value: T, label: string) {
    setError(null);
    setToast(null);
    setSavingSection(label);
    const { data: session } = await supabase.auth.getSession();
    const { error: upsertError } = await supabase.from("business_settings").upsert({
      key,
      value,
      updated_by: session.session?.user.id ?? null,
    });
    setSavingSection(null);
    if (upsertError) return setError(upsertError.message);
    setToast(`${label} saved.`);
    await queryClient.invalidateQueries({ queryKey: ["business-settings"] });
  }

  async function uploadLogo() {
    if (!logoFile) return;
    setError(null);
    setSavingSection("Logo");
    setLogoStatus("Uploading logo...");
    const safeName = logoFile.uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `company/${Date.now()}-${safeName}`;
    const { error: uploadError } = await supabase.storage.from("business-assets").upload(filePath, logoFile.uploadFile, { upsert: false });
    if (uploadError) {
      setSavingSection(null);
      return setError(uploadError.message);
    }
    const { data } = supabase.storage.from("business-assets").getPublicUrl(filePath);
    const nextCompany = { ...company, logo_url: data.publicUrl };
    setCompany(nextCompany);
    setLogoFile(null);
    setLogoStatus(null);
    await saveBusinessSetting("company_profile", nextCompany, "Company profile");
  }

  async function handleLogoChange(file: File | undefined) {
    setLogoFile(null);
    setLogoStatus(null);
    if (!file) return;
    setLogoStatus("Preparing logo...");
    try {
      const prepared = await prepareUploadFile(file, "business-asset");
      setLogoFile(prepared);
      setLogoStatus(prepared.wasCompressed ? "Logo compressed and ready to upload." : "Logo ready to upload.");
    } catch (fileError) {
      setLogoStatus((fileError as Error).message);
    }
  }

  async function savePaymentMethods() {
    await saveRows("Payment methods", "payment_methods", paymentMethodsDraft.map(cleanPaymentMethod), ["payment-methods-admin", "active-payment-methods-form"]);
  }

  async function savePlans() {
    await saveRows("Installment plans", "installment_plans", plansDraft.map(cleanPlan), ["installment-plans-admin", "active-installment-plans-contract", "public-installment-plans"]);
  }

  async function saveLotSizes() {
    await saveRows("Lot sizes", "lot_sizes", lotSizesDraft.map(cleanLotSize), ["lot-sizes-admin", "public-parcel-options", "lot-board"]);
  }

  async function saveFeeTypes() {
    await saveRows("Fee types", "fee_types", feeTypesDraft.map(cleanFeeType), ["fee-types-admin", "active-fee-types-form"]);
  }

  async function saveAiSettings() {
    if (!aiDraft) return;
    setError(null);
    setToast(null);
    setSavingSection("AI settings");
    const { error: updateError } = await supabase
      .from("ai_settings")
      .update({
        provider: aiDraft.provider,
        model: aiDraft.model,
        is_enabled: aiDraft.is_enabled,
        daily_brief_enabled: aiDraft.daily_brief_enabled,
        application_summary_enabled: aiDraft.application_summary_enabled,
        collections_assistant_enabled: aiDraft.collections_assistant_enabled,
        notes: aiDraft.notes,
      })
      .eq("id", aiDraft.id);
    setSavingSection(null);
    if (updateError) return setError(updateError.message);
    setToast("AI settings saved.");
    await queryClient.invalidateQueries({ queryKey: ["ai-settings-admin"] });
  }

  async function saveRows(label: string, table: "payment_methods" | "installment_plans" | "lot_sizes" | "fee_types", rows: Record<string, unknown>[], queryKeys: string[]) {
    setError(null);
    setToast(null);
    setSavingSection(label);
    const { error: upsertError } = await supabase.from(table).upsert(rows);
    setSavingSection(null);
    if (upsertError) return setError(upsertError.message);
    setToast(`${label} saved.`);
    await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey: [queryKey] })));
  }

  async function checkAiProvider() {
    setAiStatus("Checking AI provider...");
    const { data, error: functionError } = await supabase.functions.invoke("ai-provider-health-check", { body: {} });
    if (functionError) {
      setAiStatus(functionError.message);
      return;
    }
    setAiStatus(String(data?.message ?? "AI status checked."));
  }

  function handleAssistantClick() {
    if (!aiDraft?.is_enabled) {
      setAiStatus("AI must be enabled and connected before the assistant can be used.");
      return;
    }
    setAiStatus("Wamule AI Helper foundation is ready. Full helper behavior is not built yet.");
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setUserError(null);
    setUserMessage(null);
    setCreatingUser(true);
    const { data: result, error: functionError } = await supabase.functions.invoke("manage-admin-user", {
      body: { email, full_name: fullName, role, password: temporaryPassword || undefined },
    });
    setCreatingUser(false);
    if (functionError) return setUserError(await edgeFunctionErrorMessage(functionError));
    if (result?.error) return setUserError(String(result.error));
    setUserMessage(result?.mode === "invited" ? "User invited and role saved." : result?.mode === "existing" ? "Existing user role updated." : "User created and role saved.");
    setEmail("");
    setFullName("");
    setRole("Staff");
    setTemporaryPassword("");
    await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  }

  async function updateRole(userId: string, nextRole: AppRole) {
    setUserError(null);
    setUserMessage(null);
    const { error: updateError } = await supabase.from("admin_profiles").update({ role: nextRole }).eq("user_id", userId);
    if (updateError) return setUserError(updateError.message);
    setUserMessage("Role updated.");
    await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  }

  return (
    <>
      <PageHeader title="Settings" description="Business configuration, payment options, role management, and smart helper foundation." />
      <div className="grid gap-6">
        {settingsLoading ? <LoadingState label="Loading settings" /> : null}
        {error ? <ErrorState message={error} /> : null}
        {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
        {!canManageConfig ? (
          <div className="crm-warning-panel p-3 text-sm">
            Settings are viewable here. Your role can view records and reports, but cannot edit configuration.
          </div>
        ) : null}

        <div className="crm-tabs">
          <div className="crm-tab-list">
            {settingsSections.map((section) => (
              <button
                key={section}
                type="button"
                className={cn(
                  "crm-tab",
                  activeSection === section ? "crm-tab-active" : "",
                )}
                onClick={() => setActiveSection(section)}
              >
                {section}
              </button>
            ))}
          </div>
        </div>

        {activeSection === "Company Profile" ? (
          <div className="grid gap-6">
            <Card>
              <CardHeader><CardTitle>Company Profile</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-4 md:grid-cols-[120px_1fr] md:items-start">
                  <img src={company.logo_url || "/favicon/android-chrome-192x192.png"} alt={company.company_name} className="h-24 w-24 rounded-md border bg-muted object-cover" />
                  <Field label="Upload logo">
                    <div className="crm-subpanel grid gap-2">
                      <Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleLogoChange(event.target.files?.[0])} disabled={!canManageConfig} />
                      <UploadFileSummary file={logoFile} status={logoStatus} />
                      <Button type="button" variant="outline" disabled={!canManageConfig || !logoFile || savingSection === "Logo"} onClick={() => void uploadLogo()}>
                        {savingSection === "Logo" ? "Uploading..." : "Upload logo"}
                      </Button>
                    </div>
                  </Field>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <TextInput label="Company name" value={company.company_name} disabled={!canManageConfig} onChange={(value) => setCompany({ ...company, company_name: value })} />
                  <TextInput label="Contact email" type="email" value={company.contact_email} disabled={!canManageConfig} onChange={(value) => setCompany({ ...company, contact_email: value })} />
                  <TextInput label="Phone number" value={company.phone_number} disabled={!canManageConfig} onChange={(value) => setCompany({ ...company, phone_number: value })} />
                  <TextInput label="Website" value={company.website} disabled={!canManageConfig} onChange={(value) => setCompany({ ...company, website: value })} />
                </div>
                <Field label="Location / address">
                  <Textarea value={company.location_address} onChange={(event) => setCompany({ ...company, location_address: event.target.value })} disabled={!canManageConfig} />
                </Field>
                <Field label="Public-facing short description">
                  <Textarea value={company.short_description} onChange={(event) => setCompany({ ...company, short_description: event.target.value })} disabled={!canManageConfig} />
                </Field>
                <SectionSaveButton disabled={!canManageConfig} saving={savingSection === "Company profile"} onClick={() => void saveBusinessSetting("company_profile", company, "Company profile")} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Public Application Settings</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                <ToggleField label="Applications open" checked={application.applications_open} disabled={!canManageConfig} onChange={(checked) => setApplication({ ...application, applications_open: checked })} />
                <div className="grid gap-3 md:grid-cols-2">
                  <ToggleField label="Show lot prices publicly" checked={application.show_lot_prices_publicly} disabled={!canManageConfig} onChange={(checked) => setApplication({ ...application, show_lot_prices_publicly: checked })} />
                  <ToggleField label="Show available lot count publicly" checked={application.show_available_lot_count_publicly} disabled={!canManageConfig} onChange={(checked) => setApplication({ ...application, show_available_lot_count_publicly: checked })} />
                </div>
                <Field label="Public notice text">
                  <Textarea value={application.public_notice_text} onChange={(event) => setApplication({ ...application, public_notice_text: event.target.value })} disabled={!canManageConfig} />
                </Field>
                <Field label="Application acknowledgment text">
                  <Textarea value={application.application_acknowledgment_text} onChange={(event) => setApplication({ ...application, application_acknowledgment_text: event.target.value })} disabled={!canManageConfig} />
                </Field>
                <Field label="Default application confirmation message">
                  <Textarea value={application.default_confirmation_message} onChange={(event) => setApplication({ ...application, default_confirmation_message: event.target.value })} disabled={!canManageConfig} />
                </Field>
                <SectionSaveButton disabled={!canManageConfig} saving={savingSection === "Application settings"} onClick={() => void saveBusinessSetting("public_application", application, "Application settings")} />
              </CardContent>
            </Card>
          </div>
        ) : null}

        {activeSection === "Payment Methods" ? (
          <ConfigList
            title="Payment Methods and Bank Accounts"
            loading={paymentMethodsLoading}
            canEdit={canManageConfig}
            saving={savingSection === "Payment methods"}
            onAdd={() => setPaymentMethodsDraft((rows) => [...rows, newPaymentMethod(rows.length)])}
            onSave={() => void savePaymentMethods()}
          >
            {paymentMethodsDraft.length === 0 ? <EmptyState label="No payment methods configured." /> : null}
            {paymentMethodsDraft.map((method, index) => (
              <div key={method.id} className="grid gap-4 rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
                <RowHeader title={method.name || "New payment method"} active={method.is_active} />
                <div className="grid gap-4 md:grid-cols-3">
                  <TextInput label="Name" value={method.name} disabled={!canManageConfig} onChange={(value) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { name: value })} />
                  <Field label="Method type">
                    <Select value={method.method_type} disabled={!canManageConfig} onChange={(event) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { method_type: event.target.value as PaymentMethodType })}>
                      {paymentMethodTypes.map((type) => <option key={type}>{type}</option>)}
                    </Select>
                  </Field>
                  <TextInput label="Currency" value={method.currency} disabled={!canManageConfig} onChange={(value) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { currency: value })} />
                  <TextInput label="Bank name" value={method.bank_name ?? ""} disabled={!canManageConfig || method.method_type === "Cash"} onChange={(value) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { bank_name: value })} />
                  <TextInput label="Account name" value={method.account_name ?? ""} disabled={!canManageConfig || method.method_type === "Cash"} onChange={(value) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { account_name: value })} />
                  <TextInput label="Account number" value={method.account_number ?? ""} disabled={!canManageConfig || method.method_type === "Cash"} onChange={(value) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { account_number: value })} />
                  <NumberInput label="Sort order" value={method.sort_order} disabled={!canManageConfig} onChange={(value) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { sort_order: value })} />
                  <ToggleField label="Active" checked={method.is_active} disabled={!canManageConfig} onChange={(checked) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { is_active: checked })} />
                  <ToggleField label="Public" checked={method.is_public} disabled={!canManageConfig} onChange={(checked) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { is_public: checked })} />
                </div>
                <Field label="Instructions">
                  <Textarea value={method.instructions ?? ""} onChange={(event) => updateDraft(paymentMethodsDraft, setPaymentMethodsDraft, index, { instructions: event.target.value })} disabled={!canManageConfig} />
                </Field>
              </div>
            ))}
          </ConfigList>
        ) : null}

        {activeSection === "Installment Plans" ? (
          <ConfigList title="Installment Plans" loading={plansLoading} canEdit={canManageConfig} saving={savingSection === "Installment plans"} onAdd={() => setPlansDraft((rows) => [...rows, newPlan(rows.length)])} onSave={() => void savePlans()}>
            {plansDraft.length === 0 ? <EmptyState label="No installment plans configured." /> : null}
            {plansDraft.map((plan, index) => (
              <div key={plan.id} className="grid gap-4 rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
                <RowHeader title={plan.name || "New installment plan"} active={plan.is_active} />
                <div className="grid gap-4 md:grid-cols-3">
                  <TextInput label="Name" value={plan.name} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { name: value })} />
                  <NumberInput label="Reservation fee" value={plan.reservation_fee} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { reservation_fee: value })} />
                  <NumberInput label="Initial deposit" value={plan.initial_deposit} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { initial_deposit: value })} />
                  <NumberInput label="Final purchase price" value={plan.final_purchase_price} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { final_purchase_price: value })} />
                  <NumberInput label="Term months" value={plan.term_months} min={1} max={60} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { term_months: value })} />
                  <NumberInput label="Monthly payment" value={plan.monthly_payment} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { monthly_payment: value })} />
                  <NumberInput label="Sort order" value={plan.sort_order} disabled={!canManageConfig} onChange={(value) => updateDraft(plansDraft, setPlansDraft, index, { sort_order: value })} />
                  <ToggleField label="Active" checked={plan.is_active} disabled={!canManageConfig} onChange={(checked) => updateDraft(plansDraft, setPlansDraft, index, { is_active: checked })} />
                </div>
                <Field label="Description">
                  <Textarea value={plan.description ?? ""} onChange={(event) => updateDraft(plansDraft, setPlansDraft, index, { description: event.target.value })} disabled={!canManageConfig} />
                </Field>
                <p className="text-sm text-muted-foreground">Displayed payment: {money(Number(plan.monthly_payment || 0))} over {plan.term_months || 0} months.</p>
              </div>
            ))}
          </ConfigList>
        ) : null}

        {activeSection === "Lot Sizes" ? (
          <ConfigList title="Lot Sizes" loading={lotSizesLoading} canEdit={canManageConfig} saving={savingSection === "Lot sizes"} onAdd={() => setLotSizesDraft((rows) => [...rows, newLotSize(rows.length)])} onSave={() => void saveLotSizes()}>
            {lotSizesDraft.length === 0 ? <EmptyState label="No lot sizes configured." /> : null}
            {lotSizesDraft.map((lotSize, index) => (
              <div key={lotSize.id} className="grid gap-4 rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
                <RowHeader title={lotSize.name || "New lot size"} active={lotSize.is_active} />
                <div className="grid gap-4 md:grid-cols-3">
                  <TextInput label="Name" value={lotSize.name} disabled={!canManageConfig} onChange={(value) => updateDraft(lotSizesDraft, setLotSizesDraft, index, { name: value })} />
                  <TextInput label="Dimensions" value={lotSize.dimensions} disabled={!canManageConfig} onChange={(value) => updateDraft(lotSizesDraft, setLotSizesDraft, index, { dimensions: value })} />
                  <NumberInput label="Default price" value={lotSize.default_price} disabled={!canManageConfig} onChange={(value) => updateDraft(lotSizesDraft, setLotSizesDraft, index, { default_price: value })} />
                  <NumberInput label="Sort order" value={lotSize.sort_order} disabled={!canManageConfig} onChange={(value) => updateDraft(lotSizesDraft, setLotSizesDraft, index, { sort_order: value })} />
                  <ToggleField label="Active" checked={lotSize.is_active} disabled={!canManageConfig} onChange={(checked) => updateDraft(lotSizesDraft, setLotSizesDraft, index, { is_active: checked })} />
                </div>
                <Field label="Description">
                  <Textarea value={lotSize.description ?? ""} onChange={(event) => updateDraft(lotSizesDraft, setLotSizesDraft, index, { description: event.target.value })} disabled={!canManageConfig} />
                </Field>
              </div>
            ))}
          </ConfigList>
        ) : null}

        {activeSection === "Fee Types" ? (
          <ConfigList title="Fee Types" loading={feeTypesLoading} canEdit={canManageConfig} saving={savingSection === "Fee types"} onAdd={() => setFeeTypesDraft((rows) => [...rows, newFeeType(rows.length)])} onSave={() => void saveFeeTypes()}>
            {feeTypesDraft.length === 0 ? <EmptyState label="No fee types configured." /> : null}
            {feeTypesDraft.map((feeType, index) => (
              <div key={feeType.id} className="grid gap-4 rounded-md border border-border bg-card p-4 shadow-sm shadow-primary/5">
                <RowHeader title={feeType.name || "New fee type"} active={feeType.is_active} />
                <div className="grid gap-4 md:grid-cols-3">
                  <TextInput label="Name" value={feeType.name} disabled={!canManageConfig} onChange={(value) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { name: value })} />
                  <NumberInput label="Default amount" value={feeType.default_amount} disabled={!canManageConfig} onChange={(value) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { default_amount: value })} />
                  <Field label="Frequency">
                    <Select value={feeType.frequency} disabled={!canManageConfig} onChange={(event) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { frequency: event.target.value as FeeFrequency })}>
                      {feeFrequencies.map((frequency) => <option key={frequency}>{frequency}</option>)}
                    </Select>
                  </Field>
                  <NumberInput label="Sort order" value={feeType.sort_order} disabled={!canManageConfig} onChange={(value) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { sort_order: value })} />
                  <ToggleField label="Required" checked={feeType.is_required} disabled={!canManageConfig} onChange={(checked) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { is_required: checked })} />
                  <ToggleField label="Active" checked={feeType.is_active} disabled={!canManageConfig} onChange={(checked) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { is_active: checked })} />
                </div>
                <Field label="Description">
                  <Textarea value={feeType.description ?? ""} onChange={(event) => updateDraft(feeTypesDraft, setFeeTypesDraft, index, { description: event.target.value })} disabled={!canManageConfig} />
                </Field>
              </div>
            ))}
          </ConfigList>
        ) : null}

        {activeSection === "CRM Workflow Guide" ? <WorkflowGuideSection /> : null}

        {activeSection === "AI Settings" ? (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>AI Settings</CardTitle>
                <Badge tone={aiDraft?.is_enabled ? "green" : "gray"}>{aiDraft?.is_enabled ? "Enabled" : "Disabled"}</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              {aiLoading ? <LoadingState label="Loading AI settings" /> : null}
              <div className="crm-info-panel p-4 text-sm">
                Gemini keys are not stored in browser code. Configure `GEMINI_API_KEY` or `GOOGLE_API_KEY` as a Supabase Edge Function secret, then use the health check.
              </div>
              {aiDraft ? (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <TextInput label="Provider" value={aiDraft.provider} disabled onChange={() => undefined} />
                    <TextInput label="Model" value={aiDraft.model} disabled={!canManageAi} onChange={(value) => setAiDraft({ ...aiDraft, model: value })} />
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <ToggleField label="AI enabled" checked={aiDraft.is_enabled} disabled={!canManageAi} onChange={(checked) => setAiDraft({ ...aiDraft, is_enabled: checked })} />
                    <ToggleField label="Daily brief enabled" checked={aiDraft.daily_brief_enabled} disabled={!canManageAi} onChange={(checked) => setAiDraft({ ...aiDraft, daily_brief_enabled: checked })} />
                    <ToggleField label="Application summary enabled" checked={aiDraft.application_summary_enabled} disabled={!canManageAi} onChange={(checked) => setAiDraft({ ...aiDraft, application_summary_enabled: checked })} />
                    <ToggleField label="Collections assistant enabled" checked={aiDraft.collections_assistant_enabled} disabled={!canManageAi} onChange={(checked) => setAiDraft({ ...aiDraft, collections_assistant_enabled: checked })} />
                  </div>
                  <Field label="Notes">
                    <Textarea value={aiDraft.notes ?? ""} disabled={!canManageAi} onChange={(event) => setAiDraft({ ...aiDraft, notes: event.target.value })} />
                  </Field>
                  {aiStatus ? <div className="crm-subpanel text-sm text-muted-foreground">{aiStatus}</div> : null}
                  <div className="flex flex-wrap justify-end gap-3">
                    <Button type="button" variant="outline" onClick={() => void checkAiProvider()}>
                      <RefreshCw className="h-4 w-4" /> Check provider
                    </Button>
                    <Button type="button" variant="outline" onClick={handleAssistantClick}>
                      <Bot className="h-4 w-4" /> Wamule AI Helper
                    </Button>
                    <Button type="button" disabled={!canManageAi || savingSection === "AI settings"} onClick={() => void saveAiSettings()}>
                      {savingSection === "AI settings" ? "Saving..." : "Save AI settings"}
                    </Button>
                  </div>
                </>
              ) : (
                <EmptyState label="AI settings have not been seeded yet. Apply the latest migration first." />
              )}
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Users & Roles" ? (
          <Card>
            <CardHeader><CardTitle>Users & Roles</CardTitle></CardHeader>
            <CardContent className="grid gap-5">
              {usersLoading ? <LoadingState label="Loading users" /> : null}
              {userError ? <ErrorState message={userError} /> : null}
              {userMessage ? <Toast message={userMessage} onDismiss={() => setUserMessage(null)} /> : null}
              {!canManageUsers ? <div className="crm-warning-panel p-3 text-sm">Only Super Admin users can create users or change roles.</div> : null}
              <form className="crm-subpanel grid gap-4" onSubmit={createUser}>
                <div className="grid gap-4 md:grid-cols-2">
                  <TextInput label="Email" type="email" value={email} disabled={!canManageUsers} onChange={setEmail} />
                  <TextInput label="Full name" value={fullName} disabled={!canManageUsers} onChange={setFullName} />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Role">
                    <Select value={role} onChange={(event) => setRole(event.target.value as AppRole)} disabled={!canManageUsers}>
                      {roles.map((roleOption) => <option key={roleOption}>{roleOption}</option>)}
                    </Select>
                  </Field>
                  <TextInput label="Temporary password" type="password" value={temporaryPassword} disabled={!canManageUsers} onChange={setTemporaryPassword} />
                </div>
                <Button disabled={!canManageUsers || creatingUser}>{creatingUser ? "Saving user..." : "Create / invite user"}</Button>
              </form>
              <div className="grid gap-3">
                {users?.map((user) => (
                  <div key={user.user_id} className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-[1fr_220px] md:items-center">
                    <div>
                      <p className="font-medium">{user.full_name || user.email || user.user_id}</p>
                      <p className="text-muted-foreground">{user.email ?? "No email stored"}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={user.role === "Super Admin" ? "amber" : user.role === "Admin" ? "green" : user.role === "Staff" ? "blue" : "gray"}>{user.role}</Badge>
                      <Select value={user.role} onChange={(event) => void updateRole(user.user_id, event.target.value as AppRole)} disabled={!canManageUsers}>
                        {roles.map((roleOption) => <option key={roleOption}>{roleOption}</option>)}
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function WorkflowGuideSection() {
  const terms = [
    {
      title: "Leads",
      description: "A Lead is a person who has shown interest in a project or lot but may not yet be an applicant or customer.",
    },
    {
      title: "Follow-ups",
      description: "A Follow-up is an internal task reminding staff what action should happen next with a lead, applicant, or customer.",
    },
    {
      title: "Site Visits",
      description: "A Site Visit is an appointment for the buyer to view the project, land, or lot. Site Visits are not the same as reservations.",
    },
    {
      title: "Reservations",
      description: "A Reservation is an internal lot hold or buyer-interest hold while deposit, application, family decision, or contract next steps are being handled.",
    },
    {
      title: "Deposit Readiness",
      description: "Deposit Readiness tracks whether a deposit is pending, submitted, confirmed, waived, overdue, or cancelled. It is sales/readiness status only.",
    },
    {
      title: "Applications",
      description: "An Application is the formal buyer/application record submitted or reviewed by staff.",
    },
    {
      title: "Customers",
      description: "A Customer is a buyer who has been converted into an active account or contract relationship.",
    },
    {
      title: "Post-Sales",
      description: "The Post-Sales Checklist tracks operational steps after approval, contract start, or customer setup, including documents, agreement review, payment setup, and collections handoff.",
    },
    {
      title: "Smart Summaries",
      description: "Smart summaries and insights are staff review aids. They do not make decisions, approve applications, confirm deposits, change contracts, or send messages.",
    },
    {
      title: "Reports",
      description: "Reports are read-only summaries for management review. They do not update records or trigger workflow changes.",
    },
  ];
  const deferredSettings = [
    "Default reservation expiry days",
    "Default deposit due days",
    "Default expected deposit amount",
    "Require deposit amount when creating a reservation",
    "Require expiry date when creating a reservation",
    "Block active duplicate reservations for the same lot",
    "Default reservation status",
    "Default deposit status",
  ];

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>CRM Workflow Guide</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="crm-info-panel p-4 text-sm">
            These terms explain how Wamule tracks the buyer journey. They are operational labels for staff review and do not automate approvals, payments, contracts, or parcel status changes.
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {terms.map((term) => (
              <div key={term.title} className="crm-subpanel text-sm">
                <p className="font-medium text-primary">{term.title}</p>
                <p className="mt-1 text-muted-foreground">{term.description}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reservation Settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="crm-warning-panel p-4 text-sm">
            Reservation settings are not active yet. A future settings migration should add these CRM workflow defaults before staff can edit them here.
          </div>
          <p className="text-sm text-muted-foreground">
            Reservation settings should control CRM workflow defaults only. They must not automate payments, approvals, contracts, parcel status changes, or deposit confirmation.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {deferredSettings.map((setting) => (
              <div key={setting} className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-3 text-sm shadow-sm shadow-primary/5">
                <span className="text-foreground">{setting}</span>
                <Badge tone="gray">Deferred</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigList({
  title,
  loading,
  canEdit,
  saving,
  onAdd,
  onSave,
  children,
}: {
  title: string;
  loading: boolean;
  canEdit: boolean;
  saving: boolean;
  onAdd: () => void;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <Button type="button" variant="outline" disabled={!canEdit} onClick={onAdd}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {loading ? <LoadingState label={`Loading ${title.toLowerCase()}`} /> : null}
        {children}
        <SectionSaveButton disabled={!canEdit} saving={saving} onClick={onSave} />
      </CardContent>
    </Card>
  );
}

function RowHeader({ title, active }: { title: string; active: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="font-medium text-primary">{title}</p>
      <Badge tone={active ? "green" : "gray"}>{active ? "Active" : "Inactive"}</Badge>
    </div>
  );
}

function SectionSaveButton({ disabled, saving, onClick }: { disabled: boolean; saving: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-end">
      <Button type="button" disabled={disabled || saving} onClick={onClick}>
        {saving ? "Saving..." : "Save section"}
      </Button>
    </div>
  );
}

function ToggleField({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4 rounded-md border border-border bg-card p-3 text-sm font-medium text-foreground shadow-sm shadow-primary/5">
      <span>{label}</span>
      <input className="h-4 w-4 accent-primary disabled:opacity-50" type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function TextInput({ label, value, type = "text", disabled, onChange }: { label: string; value: string; type?: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <Input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function NumberInput({ label, value, disabled, min = 0, max, onChange }: { label: string; value: number; disabled: boolean; min?: number; max?: number; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <Input type="number" min={min} max={max} step="0.01" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="rounded-md border border-dashed bg-muted p-4 text-sm text-muted-foreground">{label}</p>;
}

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="crm-success-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <span>{message}</span>
      <button type="button" className="font-medium" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

async function edgeFunctionErrorMessage(error: unknown) {
  const fallback = error instanceof Error ? error.message : "Edge Function request failed.";
  const context = (error as { context?: Response | null })?.context;
  if (!context) return fallback;
  try {
    const payload = await context.clone().json() as { error?: unknown; message?: unknown };
    return String(payload.error ?? payload.message ?? fallback);
  } catch {
    return fallback;
  }
}

function updateDraft<T>(rows: T[], setRows: (rows: T[]) => void, index: number, updates: Partial<T>) {
  setRows(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...updates } : row)));
}

function cleanPaymentMethod(method: DraftPaymentMethod) {
  return stripNewId({
    id: method.id,
    name: method.name,
    method_type: method.method_type,
    bank_name: method.method_type === "Cash" ? null : method.bank_name || null,
    account_name: method.method_type === "Cash" ? null : method.account_name || null,
    account_number: method.method_type === "Cash" ? null : method.account_number || null,
    currency: method.currency || "BZD",
    instructions: method.instructions || null,
    is_active: method.is_active,
    is_public: method.is_public,
    sort_order: Number(method.sort_order || 0),
  }, method.isNew);
}

function cleanPlan(plan: DraftInstallmentPlan) {
  return stripNewId({
    id: plan.id,
    name: plan.name,
    description: plan.description || null,
    reservation_fee: Number(plan.reservation_fee || 0),
    initial_deposit: Number(plan.initial_deposit || 0),
    final_purchase_price: Number(plan.final_purchase_price || 0),
    term_months: Math.min(60, Math.max(1, Number(plan.term_months || 1))),
    monthly_payment: Number(plan.monthly_payment || 0),
    is_active: plan.is_active,
    sort_order: Number(plan.sort_order || 0),
  }, plan.isNew);
}

function cleanLotSize(lotSize: DraftLotSize) {
  return stripNewId({
    id: lotSize.id,
    name: lotSize.name,
    dimensions: lotSize.dimensions,
    default_price: Number(lotSize.default_price || 0),
    description: lotSize.description || null,
    is_active: lotSize.is_active,
    sort_order: Number(lotSize.sort_order || 0),
  }, lotSize.isNew);
}

function cleanFeeType(feeType: DraftFeeType) {
  return stripNewId({
    id: feeType.id,
    name: feeType.name,
    description: feeType.description || null,
    default_amount: Number(feeType.default_amount || 0),
    frequency: feeType.frequency,
    is_required: feeType.is_required,
    is_active: feeType.is_active,
    sort_order: Number(feeType.sort_order || 0),
  }, feeType.isNew);
}

function stripNewId<T extends { id: number }>(row: T, isNew?: boolean) {
  if (!isNew) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id"));
}

function newPaymentMethod(index: number): DraftPaymentMethod {
  return {
    id: -Date.now(),
    isNew: true,
    name: "New Payment Method",
    method_type: "Bank Transfer",
    bank_name: "",
    account_name: "",
    account_number: "",
    currency: "BZD",
    instructions: "",
    is_active: true,
    is_public: false,
    sort_order: (index + 1) * 10,
    created_at: "",
    updated_at: "",
  };
}

function newPlan(index: number): DraftInstallmentPlan {
  return {
    id: -Date.now(),
    isNew: true,
    name: "New Installment Plan",
    description: "",
    reservation_fee: 2500,
    initial_deposit: 2500,
    final_purchase_price: 25000,
    term_months: 60,
    monthly_payment: 375,
    is_active: true,
    sort_order: (index + 1) * 10,
    created_at: "",
    updated_at: "",
  };
}

function newLotSize(index: number): DraftLotSize {
  return {
    id: -Date.now(),
    isNew: true,
    name: "New Lot Size",
    dimensions: "",
    default_price: 25000,
    description: "",
    is_active: true,
    sort_order: (index + 1) * 10,
    created_at: "",
    updated_at: "",
  };
}

function newFeeType(index: number): DraftFeeType {
  return {
    id: -Date.now(),
    isNew: true,
    name: "New Fee Type",
    description: "",
    default_amount: 0,
    frequency: "Monthly",
    is_required: false,
    is_active: true,
    sort_order: (index + 1) * 10,
    created_at: "",
    updated_at: "",
  };
}

function settingValue<T>(settings: BusinessSetting[], key: BusinessSettingKey) {
  return (settings.find((setting) => setting.key === key)?.value ?? {}) as Partial<T>;
}
