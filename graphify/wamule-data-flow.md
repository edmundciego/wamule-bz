# Wamule Data Flow

Data flows primarily between the client and Supabase, with Edge Functions handling background processing.

## Flow
1. **Frontend Request:** React components (e.g., `ApplicationForm`) call `src/lib/supabase.ts` client.
2. **Database:** Supabase handles CRUD on entities (`applications`, `customers`, etc.).
3. **Background/Async:**
   - **Receipt Generation:** Client adds job to `receipt_jobs`. Supabase Edge Function `generate-receipts` picks it up, generates the receipt, updates `transactions`, and sets the `receipt_path`.

## Key Dependencies
- `src/lib/supabase.ts`: Centralized Supabase client.
- `src/types/database.ts`: TypeScript definitions for database schema.
