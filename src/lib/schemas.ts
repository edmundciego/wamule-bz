import { z } from "zod";

export const applicationSchema = z.object({
  applicant_full_name: z.string().min(2, "Applicant full name is required"),
  applicant_address: z.string().min(1, "Applicant address is required"),
  nationality: z.string().min(1, "Nationality is required"),
  occupation: z.string().min(1, "Occupation is required"),
  phone: z.string().min(7, "Phone number is required"),
  email: z.string().email("Enter a valid email"),
  intended_use: z.enum(["Residential", "Commercial", "Agriculture", "Investment", "Rental Property", "Other"]),
  intended_use_other: z.string().optional(),
  parcel_count: z.coerce.number().int().min(1, "Enter the number of parcels"),
  preferred_parcel_ids: z.array(z.coerce.number()).min(1, "Select at least one preferred lot"),
  alternate_lot_preference: z.string().min(1, "Alternative lot option is required"),
  payment_option: z.enum(["Installment Plan", "Paid in Full"], {
    required_error: "Select a payment option",
  }),
  applicant_acknowledgement_signature: z.string().min(1, "Type your name to acknowledge"),
  legal_notice_acknowledged: z.boolean().refine((value) => value, "Important Notice acknowledgement is required"),
  notes: z.string().optional(),
  sustainability_terms_verified: z
    .boolean()
    .refine((value) => value, "Community and sustainability terms must be acknowledged"),
}).refine((data) => data.intended_use !== "Other" || Boolean(data.intended_use_other?.trim()), {
  message: "Describe the intended use",
  path: ["intended_use_other"],
});

export const contractSchema = z
  .object({
    customer_id: z.coerce.number().min(1, "Customer is required"),
    parcel_id: z.coerce.number().min(1, "Parcel is required"),
    final_purchase_price: z.coerce.number().positive("Final price must be greater than 0"),
    initial_deposit: z.coerce.number().min(0, "Initial deposit cannot be negative"),
    term_months: z.coerce.number().int().min(1).max(60, "Contract term cannot exceed 60 months"),
    start_date: z.string().min(1, "Start date is required"),
    payment_due_day: z.coerce.number().int().min(1).max(31),
  })
  .refine((data) => data.initial_deposit <= data.final_purchase_price, {
    message: "Initial deposit cannot exceed final purchase price",
    path: ["initial_deposit"],
  });

export const paymentSchema = z
  .object({
    customer_id: z.coerce.number().min(1, "Customer is required"),
    contract_id: z.coerce.number().optional().or(z.literal("")),
    transaction_type: z.enum(["Down Payment", "Land Installment", "Garbage Fee", "Road Maintenance"]),
    amount: z.coerce.number().positive("Amount must be greater than 0"),
    collection_method: z.enum(["Cash", "Online Transfer"]),
    bank_reference: z.string().optional(),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.collection_method === "Online Transfer" && !data.bank_reference?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bank reference is required for online transfers",
        path: ["bank_reference"],
      });
    }
    if (["Down Payment", "Land Installment"].includes(data.transaction_type) && !data.contract_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Land payments require a contract",
        path: ["contract_id"],
      });
    }
  });
