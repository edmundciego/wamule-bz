export type AppRole = "Admin" | "Staff" | "Read Only";
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
export type BusinessSettingKey =
  | "company_profile"
  | "public_application"
  | "payment_settings"
  | "lot_phase";

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
  phone: string;
  email: string | null;
  parcel_id: number | null;
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

export type InstallmentPlan = {
  id: number;
  name: string;
  description: string | null;
  reservation_fee: number;
  final_purchase_price: number;
  term_months: number;
  monthly_payment: number;
  is_active: boolean;
  sort_order: number;
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
              "email" | "parcel_id" | "cultural_preservation_review" | "status" | "notes"
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
      installment_plans: {
        Row: InstallmentPlan;
        Insert: Omit<InstallmentPlan, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<InstallmentPlan, "id" | "created_at" | "updated_at">>;
      };
    };
    Views: {
      parcel_board_view: { Row: Parcel & { customer_name: string | null; contract_id: number | null } };
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
        Args: { p_application_id: number };
        Returns: void;
      };
    };
  };
};
