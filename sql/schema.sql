create extension if not exists "pgcrypto";

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists roadmap (
  id uuid primary key default gen_random_uuid(),
  quarter text not null,
  title text not null,
  description text,
  status text default 'planned',
  sort_order int default 0
);

create table if not exists team (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null,
  avatar_url text,
  linkedin_url text,
  sort_order int default 0
);

alter table subscribers enable row level security;
alter table contact_messages enable row level security;
alter table roadmap enable row level security;
alter table team enable row level security;

-- Public can read roadmap and team. Subscribers and messages have NO public policies.
create policy "public read roadmap" on roadmap for select using (true);
create policy "public read team" on team for select using (true);

insert into roadmap (quarter, title, description, status, sort_order) values
('Q1 2026','Token launch and audit','Launch and third-party audit.','done',1),
('Q2 2026','Mobile app beta','Beta release of the mobile app.','in-progress',2),
('Q3 2026','Governance portal live','Community governance portal.','planned',3),
('Q4 2026','Partnerships and exchange listings','Partner integrations and listings.','planned',4);

insert into team (name, role, avatar_url, linkedin_url, sort_order) values
('Alex Morgan','CEO','','#',1),
('Priya Raman','CTO','','#',2),
('Jordan Lee','Head of Product','','#',3);

-- Platform Authentication, Wallets, Notifications, and Audit Logs
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

alter table profiles enable row level security;
alter table wallets enable row level security;
alter table notifications enable row level security;
alter table auth_nonces enable row level security;
alter table audit_logs enable row level security;

create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

create policy "Users can view own wallets" on wallets for select using (auth.uid() = user_id);
create policy "Users can insert own wallets" on wallets for insert with check (auth.uid() = user_id);
create policy "Users can delete own wallets" on wallets for delete using (auth.uid() = user_id);

create policy "Users can view own notifications" on notifications for select using (auth.uid() = user_id);
create policy "Users can insert own notifications" on notifications for insert with check (auth.uid() = user_id);
create policy "Users can update own notifications" on notifications for update using (auth.uid() = user_id);

create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);
create policy "Enable insert for audit_logs" on audit_logs for insert with check (true);
create policy "Enable all for auth_nonces" on auth_nonces for all using (true) with check (true);

