begin;

insert into public.business_settings (key, value)
values (
  'reservation_workflow_settings',
  '{
    "default_reservation_expiry_days": 14,
    "default_deposit_due_days": 7,
    "default_expected_deposit_amount": null,
    "require_expiry_date": false,
    "require_expected_deposit_amount": false,
    "default_reservation_status": "draft",
    "default_deposit_status": "not_requested",
    "prompt_release_alternates_after_deposit_confirmed": true,
    "prompt_release_alternates_after_contract_started": true,
    "show_reservation_explanations": true
  }'::jsonb
)
on conflict (key) do nothing;

commit;
