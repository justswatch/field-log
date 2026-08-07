-- Run this once in your Supabase project's SQL Editor.
-- It creates the table Field Log stores your habits in, and locks it down
-- so each signed-in user can only ever see and edit their own row.

create table if not exists habits_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  habits jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);

alter table habits_data enable row level security;

create policy "Users can view own habits"
  on habits_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own habits"
  on habits_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own habits"
  on habits_data for update
  using (auth.uid() = user_id);
