-- 0002_platform_tables.sql
-- Safe, additive migration for Nova Spark authentication, profiles, wallets, notifications, and audit logging.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  referral_code text unique not null,
  referred_by text,
  status text default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  chain_id int default 56,
  is_primary boolean default true,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, address, chain_id)
);

create table if not exists auth_nonces (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  message text not null,
  type text default 'info',
  read boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  action text not null,
  details jsonb default '{}'::jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table profiles enable row level security;
alter table wallets enable row level security;
alter table notifications enable row level security;
alter table auth_nonces enable row level security;
alter table audit_logs enable row level security;

-- Profiles policies
drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);

drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- Wallets policies
drop policy if exists "Users can view own wallets" on wallets;
create policy "Users can view own wallets" on wallets for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own wallets" on wallets;
create policy "Users can insert own wallets" on wallets for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete own wallets" on wallets;
create policy "Users can delete own wallets" on wallets for delete using (auth.uid() = user_id);

-- Notifications policies
drop policy if exists "Users can view own notifications" on notifications;
create policy "Users can view own notifications" on notifications for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own notifications" on notifications;
create policy "Users can insert own notifications" on notifications for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own notifications" on notifications;
create policy "Users can update own notifications" on notifications for update using (auth.uid() = user_id);

-- Profiles insert policy
drop policy if exists "Users can insert own profile" on profiles;
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);

-- Audit logs & nonces policies
drop policy if exists "Enable insert for audit_logs" on audit_logs;
create policy "Enable insert for audit_logs" on audit_logs for insert with check (true);

drop policy if exists "Enable all for auth_nonces" on auth_nonces;
create policy "Enable all for auth_nonces" on auth_nonces for all using (true) with check (true);

-- Trigger to create profile when auth.users is created
create or replace function public.handle_new_user()
returns trigger as $$
declare
  new_ref_code text;
begin
  new_ref_code := 'NSP-' || upper(substr(md5(random()::text), 1, 8));
  insert into public.profiles (id, email, display_name, referral_code, referred_by)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new_ref_code,
    new.raw_user_meta_data->>'referred_by'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
