-- 003 · Hardening. Run in the Supabase SQL editor after 002. Safe to re-run.

-- 1. A 'failed' number may already be paid for at Vobiz (purchase unconfirmed or
--    routing failed): it keeps its slot until Retry settles it.
create or replace function public.reserve_phone_number(p_org uuid, p_e164 text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_limit int; v_used int; v_id uuid;
begin
  select max_numbers into v_limit from organizations where id = p_org for update;
  if v_limit is null then raise exception 'org_not_found' using errcode = 'P0001'; end if;
  select count(*) into v_used from phone_numbers
    where org_id = p_org and status in ('pending', 'active', 'failed');
  if v_used >= v_limit then raise exception 'number_limit_reached' using errcode = 'P0001'; end if;
  insert into phone_numbers (org_id, e164) values (p_org, p_e164) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.reserve_phone_number(uuid, text) from public, anon, authenticated;

-- 2. Call totals computed in Postgres (a plain select is capped at 1000 rows by PostgREST)
create or replace function public.org_call_stats(p_org uuid, p_include_legacy boolean default false)
returns table (total_calls bigint, total_seconds bigint)
language sql stable security definer set search_path = public as $$
  select count(*)::bigint, coalesce(sum(duration_seconds), 0)::bigint
  from calls
  where org_id = p_org or (p_include_legacy and org_id is null);
$$;
revoke all on function public.org_call_stats(uuid, boolean) from public, anon, authenticated;

-- 3. Indexes for the hot paths
create index if not exists messages_call_created_idx on public.messages (call_id, created_at);
create index if not exists phone_numbers_agent_idx  on public.phone_numbers (agent_id);
create index if not exists zryth_knowledge_source_idx on public.zryth_knowledge ((metadata->>'source'));
