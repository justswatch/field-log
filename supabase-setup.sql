-- Safe to re-run any time: drops each policy right before recreating it.

create table if not exists habits_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  habits jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);

alter table habits_data enable row level security;

drop policy if exists "Users can view own habits" on habits_data;
create policy "Users can view own habits"
  on habits_data for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own habits" on habits_data;
create policy "Users can insert own habits"
  on habits_data for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own habits" on habits_data;
create policy "Users can update own habits"
  on habits_data for update
  using (auth.uid() = user_id);

-- New: needed for the in-app "Delete all my data" button in Settings.
drop policy if exists "Users can delete own habits" on habits_data;
create policy "Users can delete own habits"
  on habits_data for delete
  using (auth.uid() = user_id);
