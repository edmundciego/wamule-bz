begin;

alter table public.applications
  drop constraint if exists applications_payment_option_valid;

alter table public.applications
  add constraint applications_payment_option_valid
  check (
    payment_option is null
    or length(trim(payment_option)) > 0
  );

comment on constraint applications_payment_option_valid on public.applications is
  'Allows configured public application payment plan labels while rejecting blank payment option values.';

commit;
