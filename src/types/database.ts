export type AppRole = "Super Admin" | "Admin" | "Staff" | "Read Only";
export type ParcelStatus = "Available" | "Reserved" | "Sold";
export type ParcelZoning = "Residential" | "Commercial" | "Green Space";
export type ApplicationStatus = "Pending Review" | "Approved" | "Declined";
export type TransactionType =
  | "Down Payment"
  | "Land Installment"
  | "Garbage Fee"
  | "Road Maintenance";
export type CollectionMethod = "Cash" | "Online Transfer";
export type PaymentDocumentType =
  | "Bank Transfer Proof"
  | "Manual Receipt Photo"
  | "Signed Payment Note"
  | "Other";
export type PaymentRequestStatus = "Draft" | "Sent" | "Paid" | "Cancelled";
export type ApplicationAiCompletenessStatus = "Complete" | "Needs Review" | "Missing Information" | "Lot Conflict";
export type AiDailyBriefStatus = "Draft" | "Generated" | "Sent" | "Failed";
export type BriefActionItemStatus = "Open" | "In Progress" | "Done" | "Dismissed";
export type BriefActionItemSeverity = "Info" | "Amber" | "Red";
export type EmailNotificationStatus = "Pending" | "Sent" | "Failed" | "Cancelled";
export type EmailNotificationType =
  | "New Application"
  | "Application Confirmation"
  | "Payment Request"
  | "Payment Received"
  | "Balance Statement"
  | "Daily Brief"
  | "Developer Feedback"
  | "Test Email";
export type DeveloperFeedbackType = "Bug" | "Question" | "Feature Request" | "Data Issue" | "Other";
export type DeveloperFeedbackPriority = "Low" | "Normal" | "High" | "Urgent";
export type DeveloperFeedbackStatus = "New" | "Reviewing" | "Resolved" | "Closed";
export type CustomerAiAccountStatus =
  | "Good Standing"
  | "Due Soon"
  | "Overdue"
  | "Needs Review"
  | "Missing Documents"
  | "No Active Contract";
export type PaymentMethodType = "Cash" | "Bank Transfer" | "Other";
export type FeeFrequency = "One-Time" | "Monthly" | "Yearly" | "As Needed";
export type BusinessSettingKey =
  | "company_profile"
  | "public_application"
  | "payment_settings"
  | "lot_phase";
export type LeadPipelineStage =
  | "new_lead"
  | "contacted"
  | "interested"
  | "family_decision"
  | "payment_plan_review"
  | "site_visit_scheduled"
  | "deposit_pending"
  | "deposit_paid"
  | "application_started"
  | "contract_started"
  | "closed_won"
  | "lost_inactive";
export type LeadActivityType =
  | "note"
  | "call"
  | "whatsapp"
  | "email"
  | "status_change"
  | "site_visit"
  | "follow_up"
  | "application_linked"
  | "customer_linked";
export type FollowUpTaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type FollowUpTaskPriority = "low" | "normal" | "high" | "urgent";
export type SiteVisitStatus = "scheduled" | "completed" | "no_show" | "cancelled" | "rescheduled";
export type ReservationStatus =
  | "draft"
  | "reserved"
  | "deposit_pending"
  | "deposit_submitted"
  | "deposit_confirmed"
  | "converted_to_application"
  | "converted_to_contract"
  | "expired"
  | "cancelled"
  | "released";
export type DepositStatus =
  | "not_requested"
  | "pending"
  | "proof_submitted"
  | "confirmed"
  | "overdue"
  | "waived"
  | "cancelled";
export type ReservationActivityType =
  | "note"
  | "status_change"
  | "deposit_status_change"
  | "reservation_created"
  | "reservation_released"
  | "expiration_updated"
  | "application_linked"
  | "contract_linked"
  | "payment_linked";

export type AdminProfile = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
  created_at: string;
  updated_at: string;
};

export type Parcel = {
  id: number;
  lot_number: string;
  dimensions: string;
  lot_size_id: number | null;
  lot_size_name?: string | null;
  zoning: ParcelZoning;
  status: ParcelStatus;
  base_price: number;
  created_at: string;
  updated_at: string;
};

export type Application = {
  id: number;
  first_name: string;
  last_name: string;
  applicant_full_name: string | null;
  applicant_address: string | null;
  nationality: string | null;
  occupation: string | null;
  phone: string;
  email: string | null;
  parcel_id: number | null;
  intended_use: string | null;
  intended_use_other: string | null;
  parcel_count: number | null;
  preferred_parcel_ids: number[] | null;
  alternate_lot_preference: string | null;
  payment_option: string | null;
  legal_notice_acknowledged: boolean;
  applicant_acknowledgement_signature: string | null;
  cultural_preservation_review: string | null;
  sustainability_terms_verified: boolean;
  status: ApplicationStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  parcels?: Pick<Parcel, "id" | "lot_number" | "status"> | null;
};

export type Customer = {
  id: number;
  application_id: number;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  auth_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Contract = {
  id: number;
  customer_id: number;
  parcel_id: number;
  final_purchase_price: number;
  initial_deposit: number;
  term_months: number;
  monthly_payment: number;
  start_date: string;
  payment_due_day: number;
  signed_contract_file_path: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type Transaction = {
  id: number;
  receipt_number: string;
  customer_id: number;
  contract_id: number | null;
  amount: number;
  transaction_type: TransactionType;
  collection_method: CollectionMethod;
  bank_reference: string | null;
  authorized_by: string;
  receipt_file_path: string | null;
  manual_receipt_number: string | null;
  receipt_date: string | null;
  receipt_issued_by: string | null;
  receipt_notes: string | null;
  notes: string | null;
  created_at: string;
};

export type PaymentDocument = {
  id: number;
  transaction_id: number | null;
  customer_id: number;
  document_type: PaymentDocumentType;
  file_path: string;
  original_file_name: string;
  uploaded_by: string;
  created_at: string;
};

export type PaymentRequest = {
  id: number;
  customer_id: number;
  contract_id: number | null;
  amount_due: number;
  due_date: string;
  reason: string;
  notes: string | null;
  status: PaymentRequestStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type BusinessSetting = {
  key: BusinessSettingKey;
  value: Record<string, unknown>;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Lead = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  parcel_id: number | null;
  application_id: number | null;
  customer_id: number | null;
  source: string | null;
  pipeline_stage: LeadPipelineStage;
  buyer_journey_stage: string | null;
  decision_blocker: string | null;
  budget_min: number | null;
  budget_max: number | null;
  preferred_contact_method: string | null;
  assigned_to: string | null;
  next_action: string | null;
  next_action_due_at: string | null;
  notes: string | null;
  lost_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LeadActivity = {
  id: string;
  lead_id: string;
  activity_type: LeadActivityType;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
};

export type FollowUpTask = {
  id: string;
  lead_id: string | null;
  application_id: number | null;
  customer_id: number | null;
  title: string;
  description: string | null;
  due_at: string | null;
  status: FollowUpTaskStatus;
  priority: FollowUpTaskPriority;
  assigned_to: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SiteVisit = {
  id: string;
  lead_id: string | null;
  application_id: number | null;
  customer_id: number | null;
  parcel_id: number | null;
  scheduled_at: string;
  status: SiteVisitStatus;
  visit_type: string | null;
  location: string | null;
  notes: string | null;
  assigned_to: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type LotReservation = {
  id: string;
  reservation_code: string | null;
  lead_id: string | null;
  application_id: number | null;
  customer_id: number | null;
  parcel_id: number | null;
  status: ReservationStatus;
  deposit_status: DepositStatus;
  expected_deposit_amount: number | null;
  deposit_due_at: string | null;
  deposit_paid_at: string | null;
  payment_id: number | null;
  reserved_at: string | null;
  expires_at: string | null;
  released_at: string | null;
  converted_application_id: number | null;
  converted_contract_id: number | null;
  assigned_to: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ReservationActivity = {
  id: string;
  reservation_id: string;
  activity_type: ReservationActivityType;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
};

export type InstallmentPlan = {
  id: number;
  name: string;
  description: string | null;
  reservation_fee: number;
  initial_deposit: number;
  final_purchase_price: number;
  term_months: number;
  monthly_payment: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type PaymentMethod = {
  id: number;
  name: string;
  method_type: PaymentMethodType;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  currency: string;
  instructions: string | null;
  is_active: boolean;
  is_public: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type LotSize = {
  id: number;
  name: string;
  dimensions: string;
  default_price: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type FeeType = {
  id: number;
  name: string;
  description: string | null;
  default_amount: number;
  frequency: FeeFrequency;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type AiSetting = {
  id: number;
  provider: "Gemini";
  model: string;
  is_enabled: boolean;
  daily_brief_enabled: boolean;
  application_summary_enabled: boolean;
  collections_assistant_enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ApplicationAiReview = {
  id: number;
  application_id: number;
  summary: string;
  completeness_status: ApplicationAiCompletenessStatus;
  missing_fields: string[];
  risk_flags: string[];
  recommended_admin_actions: string[];
  model: string;
  generated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AiDailyBrief = {
  id: number;
  brief_date: string;
  period_start: string;
  period_end: string;
  summary: string;
  applications_summary: string;
  lots_summary: string;
  payments_summary: string;
  contracts_summary: string;
  collections_summary: string;
  alerts: unknown[];
  recommended_actions: unknown[];
  model: string;
  status: AiDailyBriefStatus;
  generated_by: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  admin_profiles?: Pick<AdminProfile, "full_name" | "email"> | null;
};

export type CustomerAiSummary = {
  id: number;
  customer_id: number;
  summary: string;
  account_status: CustomerAiAccountStatus;
  balance_summary: string;
  payment_summary: string;
  collections_flags: unknown[];
  missing_items: unknown[];
  recommended_actions: unknown[];
  draft_follow_up_message: string;
  model: string;
  generated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BriefActionItem = {
  id: number;
  brief_id: number | null;
  source_type: string;
  source_key: string;
  title: string;
  details: string;
  severity: BriefActionItemSeverity;
  status: BriefActionItemStatus;
  related_table: string | null;
  related_record_id: string | null;
  first_seen_on: string;
  last_seen_on: string;
  resolved_at: string | null;
  dismissed_at: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailNotification = {
  id: number;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
  notification_type: EmailNotificationType;
  related_table: string | null;
  related_record_id: string | null;
  status: EmailNotificationStatus;
  error_message: string | null;
  sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NotificationSetting = {
  id: number;
  notification_type: EmailNotificationType;
  send_to_admin: boolean;
  send_to_customer: boolean;
  admin_email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DeveloperFeedback = {
  id: number;
  submitted_by: string | null;
  submitted_by_email: string | null;
  feedback_type: DeveloperFeedbackType;
  priority: DeveloperFeedbackPriority;
  page_url: string | null;
  message: string;
  status: DeveloperFeedbackStatus;
  developer_notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Database = {
  public: {
    Tables: {
      admin_profiles: {
        Row: AdminProfile;
        Insert: Omit<AdminProfile, "created_at" | "updated_at">;
        Update: Partial<Omit<AdminProfile, "created_at" | "updated_at">>;
      };
      parcels: {
        Row: Parcel;
        Insert: Partial<Omit<Parcel, "id" | "created_at" | "updated_at">> & {
          lot_number: string;
        };
        Update: Partial<Omit<Parcel, "id" | "created_at" | "updated_at">>;
      };
      applications: {
        Row: Application;
        Insert: Pick<
          Application,
          "first_name" | "last_name" | "phone" | "sustainability_terms_verified"
        > &
          Partial<
            Pick<
              Application,
              | "email"
              | "parcel_id"
              | "applicant_full_name"
              | "applicant_address"
              | "nationality"
              | "occupation"
              | "intended_use"
              | "intended_use_other"
              | "parcel_count"
              | "preferred_parcel_ids"
              | "alternate_lot_preference"
              | "payment_option"
              | "legal_notice_acknowledged"
              | "applicant_acknowledgement_signature"
              | "cultural_preservation_review"
              | "status"
              | "notes"
            >
          >;
        Update: Partial<Omit<Application, "id" | "created_at" | "updated_at" | "parcels">>;
      };
      customers: {
        Row: Customer;
        Insert: Omit<Customer, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Customer, "id" | "created_at" | "updated_at">>;
      };
      contracts: {
        Row: Contract;
        Insert: Omit<Contract, "id" | "monthly_payment" | "created_at" | "updated_at">;
        Update: Partial<Omit<Contract, "id" | "monthly_payment" | "created_at" | "updated_at">>;
      };
      transactions: {
        Row: Transaction;
        Insert: Omit<Transaction, "id" | "receipt_number" | "receipt_file_path" | "created_at">;
        Update: Partial<Omit<Transaction, "id" | "receipt_number" | "created_at">>;
      };
      payment_documents: {
        Row: PaymentDocument;
        Insert: Omit<PaymentDocument, "id" | "created_at">;
        Update: Partial<Omit<PaymentDocument, "id" | "created_at">>;
      };
      payment_requests: {
        Row: PaymentRequest;
        Insert: Omit<PaymentRequest, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<PaymentRequest, "id" | "created_at" | "updated_at">>;
      };
      business_settings: {
        Row: BusinessSetting;
        Insert: Pick<BusinessSetting, "key" | "value"> & Partial<Pick<BusinessSetting, "updated_by">>;
        Update: Partial<Pick<BusinessSetting, "value" | "updated_by">>;
      };
      leads: {
        Row: Lead;
        Insert: Pick<Lead, "full_name"> &
          Partial<Omit<Lead, "id" | "full_name" | "created_at" | "updated_at">>;
        Update: Partial<Omit<Lead, "id" | "created_at" | "updated_at">>;
      };
      lead_activities: {
        Row: LeadActivity;
        Insert: Pick<LeadActivity, "lead_id" | "activity_type" | "title"> &
          Partial<Omit<LeadActivity, "id" | "lead_id" | "activity_type" | "title" | "created_at">>;
        Update: Partial<Omit<LeadActivity, "id" | "created_at">>;
      };
      follow_up_tasks: {
        Row: FollowUpTask;
        Insert: Pick<FollowUpTask, "title"> &
          Partial<Omit<FollowUpTask, "id" | "title" | "created_at" | "updated_at">>;
        Update: Partial<Omit<FollowUpTask, "id" | "created_at" | "updated_at">>;
      };
      site_visits: {
        Row: SiteVisit;
        Insert: Pick<SiteVisit, "scheduled_at"> &
          Partial<Omit<SiteVisit, "id" | "scheduled_at" | "created_at" | "updated_at">>;
        Update: Partial<Omit<SiteVisit, "id" | "created_at" | "updated_at">>;
      };
      lot_reservations: {
        Row: LotReservation;
        Insert: Partial<Omit<LotReservation, "id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<LotReservation, "id" | "created_at" | "updated_at">>;
      };
      reservation_activities: {
        Row: ReservationActivity;
        Insert: Pick<ReservationActivity, "reservation_id" | "activity_type" | "title"> &
          Partial<Omit<ReservationActivity, "id" | "reservation_id" | "activity_type" | "title" | "created_at">>;
        Update: Partial<Omit<ReservationActivity, "id" | "created_at">>;
      };
      installment_plans: {
        Row: InstallmentPlan;
        Insert: Omit<InstallmentPlan, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<InstallmentPlan, "id" | "created_at" | "updated_at">>;
      };
      payment_methods: {
        Row: PaymentMethod;
        Insert: Omit<PaymentMethod, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<PaymentMethod, "id" | "created_at" | "updated_at">>;
      };
      lot_sizes: {
        Row: LotSize;
        Insert: Omit<LotSize, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<LotSize, "id" | "created_at" | "updated_at">>;
      };
      fee_types: {
        Row: FeeType;
        Insert: Omit<FeeType, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<FeeType, "id" | "created_at" | "updated_at">>;
      };
      ai_settings: {
        Row: AiSetting;
        Insert: Omit<AiSetting, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<AiSetting, "id" | "created_at" | "updated_at">>;
      };
      application_ai_reviews: {
        Row: ApplicationAiReview;
        Insert: Omit<ApplicationAiReview, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<ApplicationAiReview, "id" | "created_at" | "updated_at">>;
      };
      ai_daily_briefs: {
        Row: AiDailyBrief;
        Insert: Omit<AiDailyBrief, "id" | "created_at" | "updated_at" | "admin_profiles">;
        Update: Partial<Omit<AiDailyBrief, "id" | "created_at" | "updated_at" | "admin_profiles">>;
      };
      customer_ai_summaries: {
        Row: CustomerAiSummary;
        Insert: Omit<CustomerAiSummary, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<CustomerAiSummary, "id" | "created_at" | "updated_at">>;
      };
      brief_action_items: {
        Row: BriefActionItem;
        Insert: Omit<BriefActionItem, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<BriefActionItem, "id" | "created_at" | "updated_at">>;
      };
      email_notifications: {
        Row: EmailNotification;
        Insert: Omit<EmailNotification, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<EmailNotification, "id" | "created_at" | "updated_at">>;
      };
      notification_settings: {
        Row: NotificationSetting;
        Insert: Omit<NotificationSetting, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<NotificationSetting, "id" | "created_at" | "updated_at">>;
      };
      developer_feedback: {
        Row: DeveloperFeedback;
        Insert: Omit<DeveloperFeedback, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<DeveloperFeedback, "id" | "created_at" | "updated_at">>;
      };
    };
    Views: {
      parcel_board_view: { Row: Parcel & { customer_name: string | null; contract_id: number | null; customer_id: number | null } };
      public_parcel_options: {
        Row: Pick<Parcel, "id" | "lot_number" | "dimensions" | "zoning" | "status" | "base_price" | "lot_size_id"> & {
          lot_size_name: string | null;
        };
      };
      customer_balance_view: {
        Row: {
          customer_id: number;
          customer_name: string;
          land_paid: number;
          community_paid: number;
          land_balance: number;
        };
      };
    };
    Functions: {
      approve_application: {
        Args: { p_application_id: number; p_parcel_id: number };
        Returns: void;
      };
    };
  };
};
