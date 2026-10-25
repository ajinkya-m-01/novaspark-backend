-- ============================================================
-- Migration 0004: Dashboard tables
-- Run manually in Supabase SQL Editor
-- ============================================================

-- TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  wallet_id uuid REFERENCES public.wallets(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('buy', 'sell', 'stake', 'unstake', 'claim', 'referral_bonus', 'transfer_in', 'transfer_out')),
  amount numeric(36, 18) NOT NULL DEFAULT 0,
  symbol text NOT NULL DEFAULT 'TOKEN',
  usd_value numeric(18, 2),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  tx_hash text,
  block_number bigint,
  chain_id integer NOT NULL DEFAULT 97,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON public.transactions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_tx_hash ON public.transactions(tx_hash) WHERE tx_hash IS NOT NULL;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own transactions" ON public.transactions
  FOR SELECT USING (auth.uid() = user_id);

-- STAKING POSITIONS TABLE
CREATE TABLE IF NOT EXISTS public.staking_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  amount numeric(36, 18) NOT NULL DEFAULT 0,
  symbol text NOT NULL DEFAULT 'TOKEN',
  started_at timestamptz NOT NULL DEFAULT now(),
  lock_days integer NOT NULL DEFAULT 30,
  unlocks_at timestamptz NOT NULL,
  earned numeric(36, 18) NOT NULL DEFAULT 0,
  reward_rate numeric(10, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unlocked', 'claimed', 'cancelled')),
  stake_tx_hash text,
  unstake_tx_hash text,
  chain_id integer NOT NULL DEFAULT 97,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staking_user_id ON public.staking_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_staking_status ON public.staking_positions(status);

ALTER TABLE public.staking_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own staking" ON public.staking_positions
  FOR SELECT USING (auth.uid() = user_id);

-- REWARDS TABLE
CREATE TABLE IF NOT EXISTS public.rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  staking_position_id uuid REFERENCES public.staking_positions(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('staking', 'referral', 'bonus', 'airdrop')),
  amount numeric(36, 18) NOT NULL DEFAULT 0,
  symbol text NOT NULL DEFAULT 'TOKEN',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimable', 'claimed', 'expired')),
  claim_tx_hash text,
  claimable_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rewards_user_id ON public.rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_rewards_status ON public.rewards(status);
CREATE INDEX IF NOT EXISTS idx_rewards_source ON public.rewards(source);

ALTER TABLE public.rewards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own rewards" ON public.rewards
  FOR SELECT USING (auth.uid() = user_id);

-- PORTFOLIO SNAPSHOTS TABLE
CREATE TABLE IF NOT EXISTS public.portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_value numeric(18, 2) NOT NULL DEFAULT 0,
  token_balance numeric(36, 18) NOT NULL DEFAULT 0,
  staked_balance numeric(36, 18) NOT NULL DEFAULT 0,
  rewards_balance numeric(36, 18) NOT NULL DEFAULT 0,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user_recorded ON public.portfolio_snapshots(user_id, recorded_at DESC);

ALTER TABLE public.portfolio_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own portfolio" ON public.portfolio_snapshots
  FOR SELECT USING (auth.uid() = user_id);

-- ANNOUNCEMENTS TABLE
CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  type text NOT NULL DEFAULT 'general' CHECK (type IN ('general', 'update', 'alert', 'maintenance')),
  is_pinned boolean NOT NULL DEFAULT false,
  is_published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_published ON public.announcements(published_at DESC) WHERE is_published = true;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read published announcements" ON public.announcements
  FOR SELECT USING (is_published = true);

-- ADD LINK COLUMNS TO NOTIFICATIONS
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS link text,
  ADD COLUMN IF NOT EXISTS link_type text;

-- SEED ONE ANNOUNCEMENT FOR TESTING
INSERT INTO public.announcements (title, body, type, is_pinned, is_published, published_at)
VALUES (
  'Welcome to the platform',
  'Thank you for joining. Complete your KYC to unlock all features.',
  'general',
  true,
  true,
  now()
) ON CONFLICT DO NOTHING;
