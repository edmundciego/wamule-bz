import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import type { AppRole, BusinessSetting, BusinessSettingKey, InstallmentPlan } from "../types/database";

const roles: AppRole[] = ["Admin", "Staff", "Read Only"];
const settingsSections = [
  "Company",
  "Application",
  "Payments",
  "Installments",
  "Lots",
  "Users",
  "Fees",
] as const;

type SettingsSection = (typeof settingsSections)[number];

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

type PaymentSettings = {
  accepted_payment_methods: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  payment_instructions: string;
  manual_receipt_book_required: boolean;
  receipt_number_instructions: string;
};

type LotPhaseSettings = {
  phase_name: string;
  default_lot_size: string;
  default_lot_price: number;
  public_availability_display: boolean;
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

const defaultPayment: PaymentSettings = {
  accepted_payment_methods: "Cash, Online Transfer",
  bank_name: "",
  account_name: "",
  account_number: "",
  payment_instructions: "",
  manual_receipt_book_required: true,
  receipt_number_instructions: "Record the physical receipt book number after payment is received.",
};

const defaultLotPhase: LotPhaseSettings = {
  phase_name: "Phase 1",
  default_lot_size: "65 x 101 or 75 x 101 ft",
  default_lot_price: 25000,
  public_availability_display: true,
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SettingsSection>("Company");
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState<CompanyProfileSettings>(defaultCompany);
  const [application, setApplication] = useState<PublicApplicationSettings>(defaultApplication);
  const [payment, setPayment] = useState<PaymentSettings>(defaultPayment);
  const [lotPhase, setLotPhase] = useState<LotPhaseSettings>(defaultLotPhase);
  const [logoFile, setLogoFile] = useState<PreparedUploadFile | null>(null);
  const [logoStatus, setLogoStatus] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);

  const [feeError, setFeeError] = useState<string | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const [userMessage, setUserMessage] = useState<string | null>(null);
  const [garbage, setGarbage] = useState("");
  const [road, setRoad] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<AppRole>("Staff");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [draftPlans, setDraftPlans] = useState<InstallmentPlan[]>([]);

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

  const isAdmin = currentProfile?.role === "Admin";

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["business-settings"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("business_settings").select("*");
      if (queryError) throw queryError;
      return data as BusinessSetting[];
    },
  });

  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: ["installment-plans-admin"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("installment_plans")
        .select("*")
        .order("sort_order", { ascending: true });
      if (queryError) throw queryError;
      return data as InstallmentPlan[];
    },
  });

  const { data: feeSettings, isLoading: feesLoading } = useQuery({
    queryKey: ["fee-settings"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase.from("community_fee_settings").select("*").eq("is_active", true).maybeSingle();
      if (queryError) throw queryError;
      return data;
    },
  });

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from("admin_profiles")
        .select("*")
        .order("created_at", { ascending: false });
      if (queryError) throw queryError;
      return data;
    },
  });

  useEffect(() => {
    if (!settings) return;
    setCompany({ ...defaultCompany, ...settingValue<CompanyProfileSettings>(settings, "company_profile") });
    setApplication({ ...defaultApplication, ...settingValue<PublicApplicationSettings>(settings, "public_application") });
    setPayment({ ...defaultPayment, ...settingValue<PaymentSettings>(settings, "payment_settings") });
    setLotPhase({ ...defaultLotPhase, ...settingValue<LotPhaseSettings>(settings, "lot_phase") });
  }, [settings]);

  useEffect(() => {
    if (plans) setDraftPlans(plans);
  }, [plans]);

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
    if (upsertError) {
      setError(upsertError.message);
      return;
    }
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
      setError(uploadError.message);
      return;
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

  async function savePlans() {
    setError(null);
    setToast(null);
    setSavingSection("Installment plans");
    const { error: upsertError } = await supabase.from("installment_plans").upsert(
      draftPlans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        reservation_fee: Number(plan.reservation_fee),
        final_purchase_price: Number(plan.final_purchase_price),
        term_months: Number(plan.term_months),
        monthly_payment: Number(plan.monthly_payment),
        is_active: plan.is_active,
        sort_order: Number(plan.sort_order),
      })),
    );
    setSavingSection(null);
    if (upsertError) {
      setError(upsertError.message);
      return;
    }
    setToast("Installment plans saved.");
    await queryClient.invalidateQueries({ queryKey: ["installment-plans-admin"] });
  }

  async function saveFees() {
    setFeeError(null);
    setToast(null);
    const garbageAmount = Number(garbage || feeSettings?.garbage_fee_amount || 0);
    const roadAmount = Number(road || feeSettings?.road_maintenance_fee_amount || 0);
    const { error: updateError } = await supabase
      .from("community_fee_settings")
      .update({
        garbage_fee_amount: garbageAmount,
        road_maintenance_fee_amount: roadAmount,
        effective_date: new Date().toISOString().slice(0, 10),
        is_active: true,
      })
      .eq("is_active", true);
    if (updateError) {
      setFeeError(updateError.message);
      return;
    }
    setToast("Community fees saved.");
    await queryClient.invalidateQueries({ queryKey: ["fee-settings"] });
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setUserError(null);
    setUserMessage(null);
    setCreatingUser(true);
    const { data: result, error: functionError } = await supabase.functions.invoke("manage-admin-user", {
      body: {
        email,
        full_name: fullName,
        role,
        password: temporaryPassword || undefined,
      },
    });
    setCreatingUser(false);
    if (functionError) {
      setUserError(functionError.message);
      return;
    }
    if (result?.error) {
      setUserError(String(result.error));
      return;
    }
    setUserMessage(
      result?.mode === "invited"
        ? "User invited and role saved."
        : result?.mode === "existing"
          ? "Existing user role updated."
          : "User created and role saved.",
    );
    setEmail("");
    setFullName("");
    setRole("Staff");
    setTemporaryPassword("");
    await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  }

  async function updateRole(userId: string, nextRole: AppRole) {
    setUserError(null);
    setUserMessage(null);
    const { error: updateError } = await supabase
      .from("admin_profiles")
      .update({ role: nextRole })
      .eq("user_id", userId);
    if (updateError) {
      setUserError(updateError.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  }

  return (
    <>
      <PageHeader title="Settings" description="Business configuration, user management, payment settings, and installment plans." />
      <div className="grid gap-6">
        {settingsLoading ? <LoadingState label="Loading settings" /> : null}
        {error ? <ErrorState message={error} /> : null}
        {toast ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-sage/35 bg-sage/15 px-4 py-3 text-sm text-primary">
            <span>{toast}</span>
            <button type="button" className="font-medium" onClick={() => setToast(null)}>Dismiss</button>
          </div>
        ) : null}
        {!isAdmin ? (
          <div className="rounded-md border border-copper/30 bg-copper/10 p-3 text-sm text-copper">
            Settings are viewable here, but only Admin users can save changes.
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-md border bg-white">
          <div className="flex min-w-max gap-1 p-1 sm:min-w-0 sm:flex-wrap">
            {settingsSections.map((section) => (
              <button
                key={section}
                type="button"
                className={cn(
                  "h-10 rounded-md px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-primary",
                  activeSection === section ? "bg-primary text-white shadow-sm hover:bg-primary hover:text-white" : "",
                )}
                onClick={() => setActiveSection(section)}
              >
                {section}
              </button>
            ))}
          </div>
        </div>

        {activeSection === "Company" ? (
          <Card>
            <CardHeader><CardTitle>Company Profile</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 md:grid-cols-[120px_1fr] md:items-start">
                <div className="grid gap-2">
                  <img src={company.logo_url || "/favicon/android-chrome-192x192.png"} alt={company.company_name} className="h-24 w-24 rounded-md border bg-ivory object-cover" />
                </div>
                <div className="grid gap-4">
                  <Field label="Upload logo">
                    <div className="grid gap-2 rounded-md border bg-ivory/40 p-3">
                      <Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleLogoChange(event.target.files?.[0])} disabled={!isAdmin} />
                      <UploadFileSummary file={logoFile} status={logoStatus} />
                      <Button type="button" variant="secondary" disabled={!isAdmin || !logoFile || savingSection === "Logo"} onClick={() => void uploadLogo()}>
                        {savingSection === "Logo" ? "Uploading..." : "Upload logo"}
                      </Button>
                    </div>
                  </Field>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Company name">
                  <Input value={company.company_name} onChange={(event) => setCompany({ ...company, company_name: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Contact email">
                  <Input type="email" value={company.contact_email} onChange={(event) => setCompany({ ...company, contact_email: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Phone number">
                  <Input value={company.phone_number} onChange={(event) => setCompany({ ...company, phone_number: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Website">
                  <Input value={company.website} onChange={(event) => setCompany({ ...company, website: event.target.value })} disabled={!isAdmin} />
                </Field>
              </div>
              <Field label="Location / address">
                <Textarea value={company.location_address} onChange={(event) => setCompany({ ...company, location_address: event.target.value })} disabled={!isAdmin} />
              </Field>
              <Field label="Public-facing short description">
                <Textarea value={company.short_description} onChange={(event) => setCompany({ ...company, short_description: event.target.value })} disabled={!isAdmin} />
              </Field>
              <SectionSaveButton disabled={!isAdmin} saving={savingSection === "Company profile"} onClick={() => void saveBusinessSetting("company_profile", company, "Company profile")} />
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Application" ? (
          <Card>
            <CardHeader><CardTitle>Public Application Settings</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <ToggleField label="Applications open" checked={application.applications_open} disabled={!isAdmin} onChange={(checked) => setApplication({ ...application, applications_open: checked })} />
              <ToggleField label="Show lot prices publicly" checked={application.show_lot_prices_publicly} disabled={!isAdmin} onChange={(checked) => setApplication({ ...application, show_lot_prices_publicly: checked })} />
              <ToggleField label="Show available lot count publicly" checked={application.show_available_lot_count_publicly} disabled={!isAdmin} onChange={(checked) => setApplication({ ...application, show_available_lot_count_publicly: checked })} />
              <Field label="Public notice text">
                <Textarea value={application.public_notice_text} onChange={(event) => setApplication({ ...application, public_notice_text: event.target.value })} disabled={!isAdmin} />
              </Field>
              <Field label="Application acknowledgment text">
                <Textarea value={application.application_acknowledgment_text} onChange={(event) => setApplication({ ...application, application_acknowledgment_text: event.target.value })} disabled={!isAdmin} />
              </Field>
              <Field label="Default application confirmation message">
                <Textarea value={application.default_confirmation_message} onChange={(event) => setApplication({ ...application, default_confirmation_message: event.target.value })} disabled={!isAdmin} />
              </Field>
              <SectionSaveButton disabled={!isAdmin} saving={savingSection === "Application settings"} onClick={() => void saveBusinessSetting("public_application", application, "Application settings")} />
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Payments" ? (
          <Card>
            <CardHeader><CardTitle>Payment Settings</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <Field label="Accepted payment methods">
                <Input value={payment.accepted_payment_methods} onChange={(event) => setPayment({ ...payment, accepted_payment_methods: event.target.value })} disabled={!isAdmin} />
              </Field>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Bank name">
                  <Input value={payment.bank_name} onChange={(event) => setPayment({ ...payment, bank_name: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Account name">
                  <Input value={payment.account_name} onChange={(event) => setPayment({ ...payment, account_name: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Account number">
                  <Input value={payment.account_number} onChange={(event) => setPayment({ ...payment, account_number: event.target.value })} disabled={!isAdmin} />
                </Field>
              </div>
              <Field label="Payment instructions">
                <Textarea value={payment.payment_instructions} onChange={(event) => setPayment({ ...payment, payment_instructions: event.target.value })} disabled={!isAdmin} />
              </Field>
              <ToggleField label="Manual receipt book required" checked={payment.manual_receipt_book_required} disabled={!isAdmin} onChange={(checked) => setPayment({ ...payment, manual_receipt_book_required: checked })} />
              <Field label="Receipt number label / instructions">
                <Textarea value={payment.receipt_number_instructions} onChange={(event) => setPayment({ ...payment, receipt_number_instructions: event.target.value })} disabled={!isAdmin} />
              </Field>
              <SectionSaveButton disabled={!isAdmin} saving={savingSection === "Payment settings"} onClick={() => void saveBusinessSetting("payment_settings", payment, "Payment settings")} />
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Installments" ? (
          <Card>
            <CardHeader><CardTitle>Installment Plan Settings</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              {plansLoading ? <LoadingState label="Loading installment plans" /> : null}
              {draftPlans.length === 0 ? <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No installment plans found.</p> : null}
              {draftPlans.map((plan, index) => (
                <div key={plan.id} className="grid gap-4 rounded-md border bg-ivory/35 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-medium text-primary">{plan.name}</p>
                    <Badge tone={plan.is_active ? "green" : "gray"}>{plan.is_active ? "Active" : "Inactive"}</Badge>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Name">
                      <Input value={plan.name} onChange={(event) => updateDraftPlan(index, { name: event.target.value })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Description">
                      <Input value={plan.description ?? ""} onChange={(event) => updateDraftPlan(index, { description: event.target.value })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Reservation fee">
                      <Input type="number" min="0" step="0.01" value={plan.reservation_fee} onChange={(event) => updateDraftPlan(index, { reservation_fee: Number(event.target.value) })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Final purchase price">
                      <Input type="number" min="0" step="0.01" value={plan.final_purchase_price} onChange={(event) => updateDraftPlan(index, { final_purchase_price: Number(event.target.value) })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Term months">
                      <Input type="number" min="1" value={plan.term_months} onChange={(event) => updateDraftPlan(index, { term_months: Number(event.target.value) })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Monthly payment">
                      <Input type="number" min="0" step="0.01" value={plan.monthly_payment} onChange={(event) => updateDraftPlan(index, { monthly_payment: Number(event.target.value) })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Sort order">
                      <Input type="number" value={plan.sort_order} onChange={(event) => updateDraftPlan(index, { sort_order: Number(event.target.value) })} disabled={!isAdmin} />
                    </Field>
                    <ToggleField label="Plan active" checked={plan.is_active} disabled={!isAdmin} onChange={(checked) => updateDraftPlan(index, { is_active: checked })} />
                  </div>
                </div>
              ))}
              <SectionSaveButton disabled={!isAdmin} saving={savingSection === "Installment plans"} onClick={() => void savePlans()} />
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Lots" ? (
          <Card>
            <CardHeader><CardTitle>Lot / Phase Settings</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Phase name">
                  <Input value={lotPhase.phase_name} onChange={(event) => setLotPhase({ ...lotPhase, phase_name: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Default lot size">
                  <Input value={lotPhase.default_lot_size} onChange={(event) => setLotPhase({ ...lotPhase, default_lot_size: event.target.value })} disabled={!isAdmin} />
                </Field>
                <Field label="Default lot price">
                  <Input type="number" min="0" step="0.01" value={lotPhase.default_lot_price} onChange={(event) => setLotPhase({ ...lotPhase, default_lot_price: Number(event.target.value) })} disabled={!isAdmin} />
                </Field>
              </div>
              <ToggleField label="Public availability display" checked={lotPhase.public_availability_display} disabled={!isAdmin} onChange={(checked) => setLotPhase({ ...lotPhase, public_availability_display: checked })} />
              <p className="text-sm text-muted-foreground">Default public price: {money(Number(lotPhase.default_lot_price || 0))}</p>
              <SectionSaveButton disabled={!isAdmin} saving={savingSection === "Lot / phase settings"} onClick={() => void saveBusinessSetting("lot_phase", lotPhase, "Lot / phase settings")} />
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Users" ? (
          <Card>
            <CardHeader><CardTitle>User Management</CardTitle></CardHeader>
            <CardContent className="grid gap-5">
              {usersLoading ? <LoadingState label="Loading users" /> : null}
              {userError ? <ErrorState message={userError} /> : null}
              {userMessage ? <div className="rounded-md border border-sage/35 bg-sage/15 p-3 text-sm text-primary">{userMessage}</div> : null}
              <form className="grid gap-4 rounded-md border bg-ivory/40 p-4" onSubmit={createUser}>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Email">
                    <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={!isAdmin} />
                  </Field>
                  <Field label="Full name">
                    <Input value={fullName} onChange={(event) => setFullName(event.target.value)} disabled={!isAdmin} />
                  </Field>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Role">
                    <Select value={role} onChange={(event) => setRole(event.target.value as AppRole)} disabled={!isAdmin}>
                      {roles.map((roleOption) => <option key={roleOption}>{roleOption}</option>)}
                    </Select>
                  </Field>
                  <Field label="Temporary password">
                    <Input
                      type="password"
                      minLength={8}
                      placeholder="Leave blank to send invite"
                      value={temporaryPassword}
                      onChange={(event) => setTemporaryPassword(event.target.value)}
                      disabled={!isAdmin}
                    />
                  </Field>
                </div>
                <Button disabled={!isAdmin || creatingUser}>{creatingUser ? "Saving user..." : "Create / invite user"}</Button>
              </form>
              <div className="grid gap-3">
                {users?.map((user) => (
                  <div key={user.user_id} className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-[1fr_180px] md:items-center">
                    <div>
                      <p className="font-medium">{user.full_name || user.email || user.user_id}</p>
                      <p className="text-muted-foreground">{user.email ?? "No email stored"}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={user.role === "Admin" ? "green" : user.role === "Staff" ? "blue" : "gray"}>{user.role}</Badge>
                      <Select value={user.role} onChange={(event) => void updateRole(user.user_id, event.target.value as AppRole)} disabled={!isAdmin}>
                        {roles.map((roleOption) => <option key={roleOption}>{roleOption}</option>)}
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "Fees" ? (
          <Card>
            <CardHeader><CardTitle>Community Fees</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              {feesLoading ? <LoadingState /> : null}
              {feeError ? <ErrorState message={feeError} /> : null}
              <Field label="Garbage fee amount">
                <Input type="number" min="0" step="0.01" placeholder={String(feeSettings?.garbage_fee_amount ?? 0)} value={garbage} onChange={(event) => setGarbage(event.target.value)} disabled={!isAdmin} />
              </Field>
              <Field label="Road maintenance fee amount">
                <Input type="number" min="0" step="0.01" placeholder={String(feeSettings?.road_maintenance_fee_amount ?? 0)} value={road} onChange={(event) => setRoad(event.target.value)} disabled={!isAdmin} />
              </Field>
              <Button type="button" disabled={!isAdmin} onClick={() => void saveFees()}>Save fees</Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );

  function updateDraftPlan(index: number, updates: Partial<InstallmentPlan>) {
    setDraftPlans((current) => current.map((plan, planIndex) => (planIndex === index ? { ...plan, ...updates } : plan)));
  }
}

function SectionSaveButton({
  disabled,
  saving,
  onClick,
}: {
  disabled: boolean;
  saving: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex justify-end">
      <Button type="button" disabled={disabled || saving} onClick={onClick}>
        {saving ? "Saving..." : "Save section"}
      </Button>
    </div>
  );
}

function ToggleField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border bg-ivory/35 p-3 text-sm font-medium text-primary">
      <span>{label}</span>
      <input
        type="checkbox"
        className="h-4 w-4 accent-copper"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function settingValue<T>(settings: BusinessSetting[], key: BusinessSettingKey) {
  return (settings.find((setting) => setting.key === key)?.value ?? {}) as Partial<T>;
}
