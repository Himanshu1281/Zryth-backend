-- Run in the Supabase SQL editor AFTER the dashboard uses the backend. Safe to re-run.
-- Result: the browser's anon key can read/write NO app data; only the backend and the
-- agent (service/secret key, which bypasses RLS) can. Each user can only see their own
-- profile row in public.users.

-- 1. App tables: RLS on, and drop EVERY existing policy (old permissive ones kept them readable)
do $$
declare t text; p record;
begin
  foreach t in array array['calls','messages','prompts','tools','agent_prompts','agent_tools',
                           'agent_status','zryth_knowledge','knowledge_gaps','call_summaries'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- 2. Profiles: a signed-in user can only touch their own row
alter table public.users enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'users' loop
    execute format('drop policy %I on public.users', p.policyname);
  end loop;
end $$;
-- users.id is text (it holds the auth user's uuid as a string)
create policy users_select_own on public.users for select to authenticated using (auth.uid()::text = id);
create policy users_insert_own on public.users for insert to authenticated with check (auth.uid()::text = id);
create policy users_update_own on public.users for update to authenticated using (auth.uid()::text = id) with check (auth.uid()::text = id);

-- Profile row is created server-side on signup (works even when email confirmation
-- means the browser has no session yet). SignUp.tsx passes full_name/company as metadata;
-- Google sign-ins only have name/email, so NOT NULL columns get fallbacks.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, company)
  values (
    new.id::text,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1), ''),
    coalesce(new.raw_user_meta_data->>'company', '')
  )
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Knowledge bucket: private, and drop storage policies that mention it
update storage.buckets set public = false where id = 'knowledge_base';
do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and (coalesce(qual, '') ilike '%knowledge_base%' or coalesce(with_check, '') ilike '%knowledge_base%') loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

-- 4. Check: should list only the three users_* policies
select schemaname, tablename, policyname from pg_policies
where schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects');
