create table if not exists public.duo_announcements (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users (id) on delete cascade,
    account_key text not null check (char_length(account_key) between 1 and 100),
    riot_id text not null check (char_length(riot_id) between 3 and 80),
    region text not null default 'euw' check (char_length(region) between 1 and 12),
    queue text not null check (queue in ('soloDuo', 'flex')),
    primary_role text not null check (primary_role in ('top', 'jungle', 'mid', 'adc', 'support')),
    secondary_role text check (secondary_role is null or secondary_role in ('top', 'jungle', 'mid', 'adc', 'support')),
    rank_tier text not null default 'UNRANKED' check (char_length(rank_tier) <= 32),
    rank_lp integer not null default 0 check (rank_lp between 0 and 10000),
    win_rate integer check (win_rate is null or win_rate between 0 and 100),
    play_style text not null default '' check (char_length(play_style) <= 100),
    voice text not null default 'any' check (voice in ('yes', 'no', 'any')),
    goal text not null default '' check (char_length(goal) <= 80),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (owner_id, account_key),
    check (secondary_role is null or secondary_role <> primary_role)
);

create index if not exists duo_announcements_created_at_idx
    on public.duo_announcements (created_at desc);

alter table public.duo_announcements enable row level security;

revoke all on public.duo_announcements from anon;
grant select, insert, update, delete on public.duo_announcements to authenticated;

drop policy if exists "Anyone authenticated can read active duo announcements"
    on public.duo_announcements;
create policy "Anyone authenticated can read active duo announcements"
    on public.duo_announcements
    for select
    to authenticated
    using (created_at >= now() - interval '2 hours');

drop policy if exists "Owners can publish duo announcements"
    on public.duo_announcements;
create policy "Owners can publish duo announcements"
    on public.duo_announcements
    for insert
    to authenticated
    with check (owner_id = (select auth.uid()));

drop policy if exists "Owners can update duo announcements"
    on public.duo_announcements;
create policy "Owners can update duo announcements"
    on public.duo_announcements
    for update
    to authenticated
    using (owner_id = (select auth.uid()))
    with check (owner_id = (select auth.uid()));

drop policy if exists "Owners can delete duo announcements"
    on public.duo_announcements;
create policy "Owners can delete duo announcements"
    on public.duo_announcements
    for delete
    to authenticated
    using (owner_id = (select auth.uid()));

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'duo_announcements'
    ) then
        alter publication supabase_realtime add table public.duo_announcements;
    end if;
end
$$;
