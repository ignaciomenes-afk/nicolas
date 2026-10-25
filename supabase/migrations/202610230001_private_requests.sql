-- Run as the project database administrator. No credentials or customer data belong here.
begin;

create schema if not exists nicolas_private;
revoke all on schema nicolas_private from public, anon, authenticated;

create table if not exists nicolas_private.owner_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table if not exists nicolas_private.requests (
  id uuid primary key,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default clock_timestamp(),
  customer jsonb not null,
  quote jsonb not null,
  submitted_payload jsonb not null,
  approved_payload jsonb,
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  check ((status = 'approved') = (approved_payload is not null))
);
create index if not exists nicolas_requests_created_idx on nicolas_private.requests(created_at desc);
create table if not exists nicolas_private.submission_limits (
  bucket_key text not null,
  window_start timestamptz not null,
  submissions integer not null check (submissions > 0),
  primary key (bucket_key, window_start)
);
alter table nicolas_private.owner_users enable row level security;
alter table nicolas_private.requests enable row level security;
alter table nicolas_private.submission_limits enable row level security;
revoke all on all tables in schema nicolas_private from public, anon, authenticated;

create or replace function nicolas_private.require_owner() returns uuid
language plpgsql security definer set search_path = pg_catalog, nicolas_private as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists(select 1 from nicolas_private.owner_users where user_id = v_uid) then
    raise exception using errcode = 'PT403', message = 'Owner authorization required.';
  end if;
  return v_uid;
end;
$$;

create or replace function nicolas_private.require_keys(p_object jsonb, p_keys text[]) returns void
language plpgsql set search_path = pg_catalog as $$
begin
  if jsonb_typeof(p_object) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'Invalid request fields.';
  end if;
  if (select count(*) from jsonb_object_keys(p_object)) <> cardinality(p_keys) or
     not p_object ?& p_keys then
    raise exception using errcode = 'PT400', message = 'Invalid request fields.';
  end if;
end;
$$;

create or replace function nicolas_private.text_field(p_object jsonb, p_name text, p_min integer, p_max integer) returns text
language plpgsql set search_path = pg_catalog as $$
declare v_value text;
begin
  if jsonb_typeof(p_object -> p_name) is distinct from 'string' then
    raise exception using errcode = 'PT400', message = 'Invalid customer data.';
  end if;
  v_value := regexp_replace(btrim(p_object ->> p_name), '[[:space:]]+', ' ', 'g');
  if length(v_value) < p_min or length(v_value) > p_max or v_value ~ '[[:cntrl:]]' then
    raise exception using errcode = 'PT400', message = 'Invalid customer data.';
  end if;
  return v_value;
end;
$$;

create or replace function nicolas_private.integer_field(p_object jsonb, p_name text, p_min bigint, p_max bigint) returns bigint
language plpgsql set search_path = pg_catalog as $$
declare v_number numeric;
begin
  if jsonb_typeof(p_object -> p_name) is distinct from 'number' or (p_object ->> p_name) !~ '^[0-9]+$' then
    raise exception using errcode = 'PT400', message = 'Invalid numeric input.';
  end if;
  v_number := (p_object ->> p_name)::numeric;
  if v_number < p_min or v_number > p_max then
    raise exception using errcode = 'PT400', message = 'Numeric input outside allowed limits.';
  end if;
  return v_number::bigint;
end;
$$;

create or replace function nicolas_private.calendar_date(p_value text) returns date
language plpgsql set search_path = pg_catalog as $$
declare v_date date;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or substring(p_value,1,4)::integer < 1 then
    raise exception using errcode = 'PT400', message = 'Invalid calendar date.';
  end if;
  begin v_date := p_value::date;
  exception when others then raise exception using errcode = 'PT400', message = 'Invalid calendar date.'; end;
  if to_char(v_date, 'YYYY-MM-DD') <> p_value then
    raise exception using errcode = 'PT400', message = 'Invalid calendar date.';
  end if;
  return v_date;
end;
$$;

create or replace function nicolas_private.quote_snapshot(p_quote jsonb) returns jsonb
language plpgsql set search_path = pg_catalog as $$
declare
  v_principal bigint; v_months integer; v_anchor integer; v_first date; v_first_month date;
  v_month date; v_due date; v_month_days integer; v_rate integer; v_interest bigint;
  v_base bigint; v_regular bigint; v_total bigint; v_installments jsonb := '[]'::jsonb;
begin
  perform nicolas_private.require_keys(p_quote, array['policy_version','principal_cents','term_months','first_due_date','due_anchor_day']);
  if p_quote ->> 'policy_version' is distinct from 'nicolas-total-v1' then
    raise exception using errcode = 'PT400', message = 'Unsupported quote policy.';
  end if;
  v_principal := nicolas_private.integer_field(p_quote, 'principal_cents', 1, 100000000000);
  v_months := nicolas_private.integer_field(p_quote, 'term_months', 1, 24)::integer;
  v_anchor := nicolas_private.integer_field(p_quote, 'due_anchor_day', 1, 31)::integer;
  v_first := nicolas_private.calendar_date(p_quote ->> 'first_due_date');
  v_first_month := date_trunc('month', v_first)::date;
  v_month_days := extract(day from (v_first_month + interval '1 month - 1 day'))::integer;
  if extract(day from v_first)::integer <> least(v_anchor, v_month_days) then
    raise exception using errcode = 'PT400', message = 'Quote anchor does not match first payment date.';
  end if;
  v_rate := case when v_months >= 4 then 40 else 35 end;
  v_interest := (v_principal * v_rate + 50) / 100;
  v_base := v_principal + v_interest;
  v_regular := ((v_base + v_months::bigint * 100000 - 1) / (v_months::bigint * 100000)) * 100000;
  v_total := v_regular * v_months;
  for v_index in 0..v_months - 1 loop
    v_month := (v_first_month + make_interval(months => v_index))::date;
    if extract(year from v_month) > 9999 then
      raise exception using errcode = 'PT400', message = 'Payment dates exceed supported range.';
    end if;
    v_month_days := extract(day from (v_month + interval '1 month - 1 day'))::integer;
    v_due := v_month + (least(v_anchor, v_month_days) - 1);
    v_installments := v_installments || jsonb_build_array(jsonb_build_object('number', v_index + 1,
      'due_date', to_char(v_due, 'YYYY-MM-DD'), 'amount_cents', v_regular));
  end loop;
  return jsonb_build_object('policy_version', 'nicolas-total-v1', 'principal_cents', v_principal,
    'term_months', v_months, 'first_due_date', to_char(v_first,'YYYY-MM-DD'), 'due_anchor_day', v_anchor,
    'interest_percent', v_rate, 'interest_cents', v_interest, 'base_total_cents', v_base,
    'rounding_adjustment_cents', v_total - v_base, 'total_cents', v_total, 'installments', v_installments);
end;
$$;

create or replace function public.nicolas_submit_request(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, nicolas_private as $$
declare
  v_id uuid; v_customer jsonb; v_quote jsonb; v_input_quote jsonb; v_normalized jsonb;
  v_name text; v_cuil text; v_phone text; v_sum integer := 0; v_weights integer[] := array[5,4,3,2,7,6,5,4,3,2];
  v_existing nicolas_private.requests%rowtype; v_window timestamptz; v_count integer; v_limit_key text;
begin
  if p_payload is null or octet_length(p_payload::text) > 16384 then
    raise exception using errcode = 'PT413', message = 'Request exceeds size limit.';
  end if;
  perform nicolas_private.require_keys(p_payload, array['request_id','customer','quote','contact_consent']);
  if jsonb_typeof(p_payload -> 'request_id') is distinct from 'string' or
     (p_payload ->> 'request_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
     p_payload -> 'contact_consent' is distinct from 'true'::jsonb then
    raise exception using errcode = 'PT400', message = 'Invalid identifier or missing consent.';
  end if;
  v_id := (p_payload ->> 'request_id')::uuid;
  v_customer := p_payload -> 'customer';
  perform nicolas_private.require_keys(v_customer, array['full_name','cuil','address_street','address_number','locality','client_whatsapp']);
  v_name := nicolas_private.text_field(v_customer, 'full_name', 3, 160);
  if position(' ' in v_name) = 0 then raise exception using errcode = 'PT400', message = 'Full name required.'; end if;
  v_cuil := regexp_replace(nicolas_private.text_field(v_customer, 'cuil', 11, 24), '[ -]', '', 'g');
  if v_cuil !~ '^(20|23|24|27)[0-9]{9}$' then raise exception using errcode = 'PT400', message = 'Invalid CUIL.'; end if;
  for v_index in 1..10 loop v_sum := v_sum + substring(v_cuil, v_index, 1)::integer * v_weights[v_index]; end loop;
  if (v_sum + substring(v_cuil, 11, 1)::integer) % 11 <> 0 then
    raise exception using errcode = 'PT400', message = 'Invalid CUIL checksum.';
  end if;
  v_phone := nicolas_private.text_field(v_customer, 'client_whatsapp', 8, 16);
  if v_phone !~ '^\+?[1-9][0-9]{7,14}$' then raise exception using errcode = 'PT400', message = 'International phone required.'; end if;
  v_phone := ltrim(v_phone, '+');
  if left(v_phone, 2) = '54' and v_phone !~ '^(54[0-9]{10}|549[0-9]{10})$' then
    raise exception using errcode = 'PT400', message = 'Invalid Argentine phone.';
  end if;
  v_customer := jsonb_build_object('full_name', v_name, 'cuil', v_cuil,
    'address_street', nicolas_private.text_field(v_customer, 'address_street', 1, 160),
    'address_number', nicolas_private.text_field(v_customer, 'address_number', 1, 40),
    'locality', nicolas_private.text_field(v_customer, 'locality', 1, 120), 'client_whatsapp', v_phone);
  v_quote := nicolas_private.quote_snapshot(p_payload -> 'quote');
  v_input_quote := jsonb_build_object('policy_version', v_quote -> 'policy_version', 'principal_cents', v_quote -> 'principal_cents',
    'term_months', v_quote -> 'term_months', 'first_due_date', v_quote -> 'first_due_date', 'due_anchor_day', v_quote -> 'due_anchor_day');
  v_normalized := jsonb_build_object('request_id', v_id::text, 'customer', v_customer, 'quote', v_input_quote, 'contact_consent', true);
  -- All submissions share one short transaction lock: bounds count/PII growth under concurrency.
  perform pg_advisory_xact_lock(7264910031);
  select * into v_existing from nicolas_private.requests where id = v_id;
  if found then
    if v_existing.submitted_payload <> v_normalized then
      raise exception using errcode = 'PT409', message = 'Identifier already used for different input.', detail = 'idempotency_conflict';
    end if;
    -- Anonymous callers never learn the owner's decision or any stored personal data.
    return jsonb_build_object('request_id', v_id::text, 'status', 'pending');
  end if;
  if nicolas_private.calendar_date(v_quote ->> 'first_due_date') <= (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception using errcode = 'PT400', message = 'First payment must be in the future.';
  end if;
  v_window := date_trunc('hour', clock_timestamp());
  delete from nicolas_private.submission_limits where window_start < v_window - interval '24 hours';
  foreach v_limit_key in array array['global', 'cuil:' || md5(v_cuil)] loop
    insert into nicolas_private.submission_limits(bucket_key, window_start, submissions) values(v_limit_key, v_window, 1)
      on conflict(bucket_key, window_start) do update set submissions = nicolas_private.submission_limits.submissions + 1
      returning submissions into v_count;
    if v_count > (case when v_limit_key = 'global' then 120 else 3 end) then
      raise exception using errcode = 'PT429', message = 'Submission rate limit reached.';
    end if;
  end loop;
  if (select count(*) from nicolas_private.requests) >= 1000 then
    raise exception using errcode = 'PT429', message = 'Inbox capacity reached.';
  end if;
  insert into nicolas_private.requests(id, customer, quote, submitted_payload) values(v_id, v_customer, v_quote, v_normalized);
  return jsonb_build_object('request_id', v_id::text, 'status', 'pending');
end;
$$;

create or replace function public.nicolas_list_requests() returns jsonb
language plpgsql security definer set search_path = pg_catalog, nicolas_private as $$
declare v_rows jsonb;
begin
  perform nicolas_private.require_owner();
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'created_at', created_at,
    'customer', customer, 'quote', quote, 'approved_payload', approved_payload) order by created_at desc, id), '[]'::jsonb)
    into v_rows from nicolas_private.requests;
  return v_rows;
end;
$$;

create or replace function public.nicolas_approve_request(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, nicolas_private as $$
declare v_uid uuid; v_row nicolas_private.requests%rowtype; v_now timestamptz; v_issued date; v_payload jsonb;
begin
  v_uid := nicolas_private.require_owner();
  select * into v_row from nicolas_private.requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'Request not found.'; end if;
  if v_row.status = 'approved' then return v_row.approved_payload; end if;
  if v_row.status <> 'pending' then raise exception using errcode = 'PT409', message = 'Only pending requests can be approved.'; end if;
  v_now := clock_timestamp(); v_issued := (v_now at time zone 'America/Argentina/Buenos_Aires')::date;
  if nicolas_private.calendar_date(v_row.quote ->> 'first_due_date') <= v_issued then
    raise exception using errcode = 'PT409', message = 'First payment must be after approval date.', detail = 'stale_first_due_date';
  end if;
  v_payload := jsonb_build_object('request_id', v_row.id::text, 'approved_at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'issued_date', to_char(v_issued,'YYYY-MM-DD'), 'customer', v_row.customer, 'quote', v_row.quote);
  update nicolas_private.requests set status = 'approved', approved_payload = v_payload, decided_at = v_now, decided_by = v_uid where id = v_row.id;
  return v_payload;
end;
$$;

create or replace function public.nicolas_reject_request(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, nicolas_private as $$
declare v_uid uuid; v_row nicolas_private.requests%rowtype;
begin
  v_uid := nicolas_private.require_owner();
  select * into v_row from nicolas_private.requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'Request not found.'; end if;
  if v_row.status = 'approved' then raise exception using errcode = 'PT409', message = 'Approved requests cannot be rejected.'; end if;
  if v_row.status = 'pending' then
    update nicolas_private.requests set status = 'rejected', decided_at = clock_timestamp(), decided_by = v_uid where id = v_row.id;
  end if;
  return jsonb_build_object('id', v_row.id::text, 'status', 'rejected');
end;
$$;

-- This is deliberately an invoker function. An Auth session or a service-role
-- API key cannot claim ownership; the caller must also possess database write
-- privileges through the Management API (normally the project postgres owner).
create or replace function nicolas_private.claim_first_owner(p_user_id uuid) returns uuid
language plpgsql security invoker set search_path = pg_catalog, nicolas_private as $$
begin
  if current_user <> 'postgres' and current_user <> (
    select pg_get_userbyid(datdba) from pg_database where datname = current_database()
  ) then
    raise exception using errcode = 'PT403', message = 'Database owner privileges required.';
  end if;
  if p_user_id is null or not exists (
    select 1 from auth.users where id = p_user_id and email_confirmed_at is not null
  ) then
    raise exception using errcode = 'PT403', message = 'A confirmed email account is required.';
  end if;
  lock table nicolas_private.owner_users in exclusive mode;
  if exists (select 1 from nicolas_private.owner_users where user_id <> p_user_id) then
    raise exception using errcode = 'PT409', message = 'An owner has already been configured.';
  end if;
  insert into nicolas_private.owner_users(user_id) values (p_user_id)
    on conflict (user_id) do nothing;
  return p_user_id;
end;
$$;

revoke all on all functions in schema nicolas_private from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function nicolas_private.claim_first_owner(uuid) from service_role;
  end if;
end; $$;
revoke all on function public.nicolas_submit_request(jsonb) from public, anon, authenticated;
revoke all on function public.nicolas_list_requests() from public, anon, authenticated;
revoke all on function public.nicolas_approve_request(uuid) from public, anon, authenticated;
revoke all on function public.nicolas_reject_request(uuid) from public, anon, authenticated;
grant execute on function public.nicolas_submit_request(jsonb) to anon, authenticated;
grant execute on function public.nicolas_list_requests() to authenticated;
grant execute on function public.nicolas_approve_request(uuid) to authenticated;
grant execute on function public.nicolas_reject_request(uuid) to authenticated;

comment on schema nicolas_private is 'Private request PII. Never expose this schema through the Data API.';
comment on function nicolas_private.claim_first_owner(uuid) is 'First-owner claim: confirmed Auth user plus database-owner write access; no public RPC grant.';
comment on function public.nicolas_submit_request(jsonb) is 'Anonymous write-only inbox submission; no PII or decision status is returned.';
notify pgrst, 'reload schema';
commit;
