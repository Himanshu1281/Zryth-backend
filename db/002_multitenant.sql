-- 002 · Multi-tenant model: organizations → agents (copies of templates) → phone numbers.
-- Run once in the Supabase SQL editor, AFTER deploy/lock-down-rls.sql. Safe to re-run.
--
--   organizations ─┬─ org_members (user ↔ org, role)
--                  ├─ agents ──────── template_id → agent_templates (admin-managed)
--                  │    └─ zryth_knowledge.agent_id   (each agent's own knowledge base)
--                  ├─ phone_numbers ─ agent_id (set ONCE, then immutable)
--                  └─ calls (org_id, agent_id, dialed_number)
--
-- All tables are backend-only: RLS on, no policies. The backend (service key) enforces
-- org scoping; the voice agent (secret key) reads numbers/agents to route calls.

-- ── Organizations ─────────────────────────────────────────────────────────────
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  max_numbers int  not null default 1,            -- purchase limit until billing exists
  created_at  timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members (user_id);

-- ── Agent templates (published by Zryth admins) ───────────────────────────────
create table if not exists public.agent_templates (
  id               text primary key,               -- also the key in agent_prompts / agent_tools
  name             text not null,
  description      text not null default '',
  persona_name     text not null default 'Maya',
  default_language text not null default 'en' check (default_language in ('en', 'hi')),
  is_published     boolean not null default true,
  created_at       timestamptz not null default now()
);
insert into public.agent_templates (id, name, description, persona_name)
values ('maya_v2', 'Maya — AI Receptionist',
        'Answers callers in English or Hindi from your knowledge base, captures leads, books consultations and transfers to your team.',
        'Maya')
on conflict (id) do nothing;

-- ── Agents (an organization's own copy of a template) ─────────────────────────
create table if not exists public.agents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  template_id     text not null references public.agent_templates(id),
  name            text not null,
  business_name   text not null,
  greeting        text,                            -- null = template greeting with business_name
  transfer_number text,                            -- null = no human transfer
  language        text not null default 'en' check (language in ('en', 'hi')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists agents_org_idx on public.agents (org_id);

-- template_id never changes after creation
create or replace function public.agents_guard() returns trigger
language plpgsql as $$
begin
  if new.template_id is distinct from old.template_id or new.org_id is distinct from old.org_id then
    raise exception 'agent_template_immutable' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists agents_guard on public.agents;
create trigger agents_guard before update on public.agents
  for each row execute function public.agents_guard();

-- ── Phone numbers (bought from Vobiz, bound to one agent forever) ─────────────
create table if not exists public.phone_numbers (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete restrict,
  e164            text not null unique,            -- +91XXXXXXXXXX
  status          text not null default 'pending' check (status in ('pending', 'active', 'failed', 'released')),
  agent_id        uuid references public.agents(id) on delete restrict,
  vobiz_number_id text,
  setup_fee       numeric,
  monthly_fee     numeric,
  currency        text,
  error           text,
  purchased_at    timestamptz,
  bound_at        timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists phone_numbers_org_idx on public.phone_numbers (org_id);

-- The number ↔ agent binding is permanent, and the agent must belong to the same org.
create or replace function public.phone_numbers_guard() returns trigger
language plpgsql as $$
begin
  if new.e164 is distinct from old.e164 or new.org_id is distinct from old.org_id then
    raise exception 'phone_number_identity_immutable' using errcode = 'P0001';
  end if;
  if old.agent_id is not null and new.agent_id is distinct from old.agent_id then
    raise exception 'phone_number_already_bound' using errcode = 'P0001';
  end if;
  if old.agent_id is null and new.agent_id is not null then
    if new.status <> 'active' then
      raise exception 'phone_number_not_active' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.agents a where a.id = new.agent_id and a.org_id = new.org_id) then
      raise exception 'agent_not_in_org' using errcode = 'P0001';
    end if;
    new.bound_at := now();
  end if;
  return new;
end $$;
drop trigger if exists phone_numbers_guard on public.phone_numbers;
create trigger phone_numbers_guard before update on public.phone_numbers
  for each row execute function public.phone_numbers_guard();

-- Atomically check the org's limit and reserve a row before Vobiz is charged.
-- Two concurrent purchases can't both slip under max_numbers (row lock on the org).
create or replace function public.reserve_phone_number(p_org uuid, p_e164 text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_limit int; v_used int; v_id uuid;
begin
  select max_numbers into v_limit from organizations where id = p_org for update;
  if v_limit is null then raise exception 'org_not_found' using errcode = 'P0001'; end if;
  select count(*) into v_used from phone_numbers where org_id = p_org and status in ('pending', 'active');
  if v_used >= v_limit then raise exception 'number_limit_reached' using errcode = 'P0001'; end if;
  insert into phone_numbers (org_id, e164) values (p_org, p_e164) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.reserve_phone_number(uuid, text) from public, anon, authenticated;

-- ── Calls & knowledge get tenant columns ──────────────────────────────────────
alter table public.calls add column if not exists org_id        uuid references public.organizations(id) on delete set null;
-- calls.agent_id already exists (uuid, unused so far): it now points at the answering org agent
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calls_agent_id_fkey') then
    update public.calls set agent_id = null
      where agent_id is not null and agent_id not in (select id from public.agents);
    alter table public.calls add constraint calls_agent_id_fkey
      foreign key (agent_id) references public.agents(id) on delete set null;
  end if;
end $$;
alter table public.calls add column if not exists dialed_number text;
create index if not exists calls_org_started_idx on public.calls (org_id, started_at desc);

-- null agent_id = Zryth's own (legacy/default line) knowledge, managed by admins
alter table public.zryth_knowledge add column if not exists agent_id uuid references public.agents(id) on delete cascade;
create index if not exists zryth_knowledge_agent_idx on public.zryth_knowledge (agent_id);

-- ── RLS: backend-only ─────────────────────────────────────────────────────────
alter table public.organizations   enable row level security;
alter table public.org_members     enable row level security;
alter table public.agent_templates enable row level security;
alter table public.agents          enable row level security;
alter table public.phone_numbers   enable row level security;

-- ── Every user gets an organization (signup trigger + backfill) ───────────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  insert into public.users (id, email, full_name, company)
  values (
    new.id::text,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1), ''),
    coalesce(new.raw_user_meta_data->>'company', '')
  )
  on conflict (id) do nothing;

  insert into public.organizations (name, owner_id)
  values (coalesce(nullif(new.raw_user_meta_data->>'company', ''), nullif(new.raw_user_meta_data->>'full_name', ''), new.email), new.id)
  returning id into v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, new.id, 'owner');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Existing users without an org
do $$
declare u record; v_org uuid;
begin
  for u in
    select au.id, au.email, pu.company, pu.full_name
    from auth.users au left join public.users pu on pu.id = au.id::text
    where not exists (select 1 from public.org_members m where m.user_id = au.id)
  loop
    insert into public.organizations (name, owner_id)
    values (coalesce(nullif(u.company, ''), nullif(u.full_name, ''), u.email), u.id)
    returning id into v_org;
    insert into public.org_members (org_id, user_id, role) values (v_org, u.id, 'owner');
  end loop;
end $$;
