-- Velura - Supabase-Schema (Postgres + RLS + Realtime + RPC).
-- In Supabase: SQL Editor -> dieses Skript ausfuehren.
-- Voraussetzung: "Anonymous sign-ins" in Auth-Einstellungen aktivieren.

-- ===========================================================================
-- Profile (1:1 zu auth.users)
-- ===========================================================================
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default 'Gast',
  is_guest      boolean not null default false,
  age_confirmed boolean not null default false,
  is_moderator  boolean not null default false,
  is_banned     boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Angemeldete duerfen Profile lesen (fuer Anzeigename des Partners).
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

-- Nur das eigene Profil aendern (aber nicht Moderator/Bann-Flags hochstufen).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Profil automatisch bei neuem Auth-User anlegen (Daten aus user_metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, is_guest, age_confirmed)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), 'Gast'),
    coalesce((new.raw_user_meta_data->>'is_guest')::boolean, false),
    coalesce((new.raw_user_meta_data->>'age_confirmed')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- Matchmaking: Warteschlange + Matches
-- ===========================================================================
create table if not exists public.match_queue (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.match_queue enable row level security;
-- Nur den eigenen Eintrag verwalten (Paaren erfolgt ueber SECURITY DEFINER RPC).
drop policy if exists "queue_own" on public.match_queue;
create policy "queue_own" on public.match_queue
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.matches (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references auth.users(id) on delete cascade, -- Initiator
  user_b     uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.matches enable row level security;
-- Beteiligte duerfen ihr Match sehen (auch fuer Realtime-Benachrichtigung).
drop policy if exists "matches_own" on public.matches;
create policy "matches_own" on public.matches
  for select to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

-- Atomares Paaren: nimmt einen Wartenden (SKIP LOCKED) oder stellt sich an.
-- Rueckgabe: Match-Zeile, falls sofort gepaart (Aufrufer = Initiator), sonst NULL.
create or replace function public.request_match()
returns public.matches language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  partner uuid;
  m public.matches;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from profiles where id = me and is_banned) then
    raise exception 'banned';
  end if;

  select user_id into partner
    from match_queue
    where user_id <> me
    order by created_at
    for update skip locked
    limit 1;

  if partner is not null then
    delete from match_queue where user_id in (me, partner);
    insert into matches(user_a, user_b) values (me, partner) returning * into m;
    return m;
  else
    insert into match_queue(user_id) values (me)
      on conflict (user_id) do update set created_at = now();
    return null;
  end if;
end;
$$;

-- Warteschlange verlassen.
create or replace function public.leave_queue()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from match_queue where user_id = auth.uid();
end;
$$;

-- ===========================================================================
-- Meldungen
-- ===========================================================================
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  reported_id uuid references auth.users(id) on delete set null,
  reason      text not null,
  details     text,
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);
alter table public.reports enable row level security;

-- Angemeldete duerfen eine Meldung als sich selbst erstellen.
drop policy if exists "reports_insert" on public.reports;
create policy "reports_insert" on public.reports
  for insert to authenticated
  with check (auth.uid() = reporter_id);

-- Moderatoren duerfen alle Meldungen lesen.
drop policy if exists "reports_mod_select" on public.reports;
create policy "reports_mod_select" on public.reports
  for select to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ===========================================================================
-- Moderation (RPC, jeweils mit Moderator-Pruefung)
-- ===========================================================================
create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_moderator);
$$;

create or replace function public.mod_open_reports()
returns table (
  id uuid, reason text, details text, created_at timestamptz,
  reporter_name text, reported_id uuid, reported_name text, reported_guest boolean
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'forbidden'; end if;
  return query
    select r.id, r.reason, r.details, r.created_at,
           rp.display_name, r.reported_id, tp.display_name, tp.is_guest
    from reports r
    left join profiles rp on rp.id = r.reporter_id
    left join profiles tp on tp.id = r.reported_id
    where r.status = 'open'
    order by r.created_at desc
    limit 200;
end;
$$;

create or replace function public.mod_ban_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'forbidden'; end if;
  update profiles set is_banned = true where id = target;
  delete from match_queue where user_id = target;
  update reports set status = 'actioned' where reported_id = target;
end;
$$;

create or replace function public.mod_dismiss_report(report_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'forbidden'; end if;
  update reports set status = 'reviewed' where id = report_id;
end;
$$;

-- ===========================================================================
-- Realtime: matches-Tabelle fuer Benachrichtigung der wartenden Seite
-- ===========================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches'
  ) then
    alter publication supabase_realtime add table public.matches;
  end if;
end $$;
