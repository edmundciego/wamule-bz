-- NO-OP: This migration originally contained an unsafe hard-delete payment RPC.
-- It was never applied to any known Wamule environment and was replaced before
-- staging use. Payment correction is implemented by the later immutable void
-- lifecycle in 20260714210447_critical_correctness_batch_1.sql.
--
-- Keep this timestamped no-op so migration ordering remains stable for any
-- checkout that already contains this file. Do not reintroduce a delete RPC.
do $$
begin
  raise notice 'Skipping retired unsafe payment-removal migration; no database objects created.';
end;
$$;
