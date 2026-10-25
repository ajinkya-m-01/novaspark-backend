-- ============================================================
-- Migration 0005: Admin panel tables and columns
-- Run manually in Supabase SQL Editor
-- ============================================================

-- ─── PROFILES: admin/role/kyc columns ──────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS kyc_status text NOT NULL DEFAULT 'not_started';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS check_role,
  ADD CONSTRAINT check_role CHECK (role IN ('user', 'admin', 'moderator'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS check_kyc_status,
  ADD CONSTRAINT check_kyc_status
    CHECK (kyc_status IN ('not_started', 'pending', 'approved', 'rejected', 'resubmit'));

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_kyc_status ON public.profiles(kyc_status);
CREATE INDEX IF NOT EXISTS idx_profiles_sponsor_id ON public.profiles(sponsor_id);

-- ─── KYC SUBMISSIONS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kyc_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('passport', 'national_id', 'drivers_license')),
  document_number text NOT NULL,
  full_name text NOT NULL,
  date_of_birth date,
  country_iso2 text,
  front_url text,
  back_url text,
  selfie_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'resubmit')),
  reason text,
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_submissions_user_id ON public.kyc_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_submissions_status ON public.kyc_submissions(status);
CREATE INDEX IF NOT EXISTS idx_kyc_submissions_submitted_at ON public.kyc_submissions(submitted_at DESC);

ALTER TABLE public.kyc_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own KYC submissions" ON public.kyc_submissions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own KYC submissions" ON public.kyc_submissions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── PRESALE ROUNDS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.presale_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_number int NOT NULL DEFAULT 1,
  name text NOT NULL,
  price_usd numeric(18, 8) NOT NULL CHECK (price_usd > 0),
  hard_cap numeric(36, 18) NOT NULL CHECK (hard_cap > 0),
  tokens_sold numeric(36, 18) NOT NULL DEFAULT 0,
  min_per_wallet numeric(36, 18) NOT NULL DEFAULT 0,
  max_per_wallet numeric(36, 18) NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'paused', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (min_per_wallet < max_per_wallet)
);

CREATE INDEX IF NOT EXISTS idx_presale_rounds_status ON public.presale_rounds(status);

ALTER TABLE public.presale_rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read presale rounds" ON public.presale_rounds
  FOR SELECT USING (true);

-- ─── STAKING CONFIG ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staking_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_days int NOT NULL,
  reward_rate_bps int NOT NULL CHECK (reward_rate_bps >= 0 AND reward_rate_bps <= 10000),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lock_days)
);

ALTER TABLE public.staking_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read staking config" ON public.staking_config
  FOR SELECT USING (true);

INSERT INTO public.staking_config (lock_days, reward_rate_bps, is_active) VALUES
  (30, 500, true),
  (90, 900, true),
  (180, 1400, true),
  (365, 2000, true)
ON CONFLICT (lock_days) DO NOTHING;

-- ─── WITHDRAWAL REQUESTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount numeric(36, 18) NOT NULL CHECK (amount > 0),
  symbol text NOT NULL DEFAULT 'TOKEN',
  wallet_address text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processed')),
  tx_hash text,
  reason text,
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON public.withdrawal_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON public.withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_created_at ON public.withdrawal_requests(created_at DESC);

ALTER TABLE public.withdrawal_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own withdrawal requests" ON public.withdrawal_requests
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own withdrawal requests" ON public.withdrawal_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── SUPPORT TICKETS + MESSAGES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES public.profiles(id),
  message text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON public.support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON public.support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id ON public.support_messages(ticket_id);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own tickets" ON public.support_tickets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own tickets" ON public.support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see messages on own tickets" ON public.support_messages
  FOR SELECT USING (
    is_internal = false AND
    ticket_id IN (SELECT id FROM public.support_tickets WHERE user_id = auth.uid())
  );
CREATE POLICY "Users insert messages on own tickets" ON public.support_messages
  FOR INSERT WITH CHECK (
    is_internal = false AND
    ticket_id IN (SELECT id FROM public.support_tickets WHERE user_id = auth.uid())
  );

-- ─── CONTENT: roadmap / team extra columns ───────────────────────────────────
ALTER TABLE public.roadmap
  ADD COLUMN IF NOT EXISTS date date,
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'general';

ALTER TABLE public.team
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS social_links jsonb DEFAULT '{}'::jsonb;

-- ─── ADMIN AUDIT LOG: RLS (table already exists, no policies yet) ────────────
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read audit log" ON public.admin_audit_log
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- ─── ADMIN RLS: broad read/write for admins on operational tables ───────────
CREATE POLICY "Admins manage kyc submissions" ON public.kyc_submissions
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY "Admins manage withdrawal requests" ON public.withdrawal_requests
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY "Admins manage support tickets" ON public.support_tickets
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY "Admins manage support messages" ON public.support_messages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY "Admins manage presale rounds" ON public.presale_rounds
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
CREATE POLICY "Admins manage staking config" ON public.staking_config
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );
