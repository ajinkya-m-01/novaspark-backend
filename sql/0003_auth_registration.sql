-- =====================================================
-- Migration 0003: Auth Registration Enhancements
-- Run in Supabase SQL editor
-- =====================================================

-- Add missing columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS mobile_number text,
  ADD COLUMN IF NOT EXISTS country_code text,         -- dial code e.g. "+91"
  ADD COLUMN IF NOT EXISTS country_iso2 text,         -- ISO2 e.g. "IN", "AE", "SG"
  ADD COLUMN IF NOT EXISTS country text,              -- full name e.g. "India"
  ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS unique_user_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS sponsor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_restricted_country boolean DEFAULT false;

-- Enforce valid account statuses
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS check_account_status,
  ADD CONSTRAINT check_account_status
    CHECK (status IN ('active', 'suspended', 'frozen', 'blocked'));

-- Email OTP table
CREATE TABLE IF NOT EXISTS public.email_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination text NOT NULL,
  code_hash text NOT NULL,
  type text NOT NULL DEFAULT 'registration',
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_otps_lookup
  ON public.email_otps (destination, expires_at)
  WHERE consumed = false;

-- Admin audit log table
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES public.profiles(id),
  action text NOT NULL,
  target_user_id uuid REFERENCES public.profiles(id),
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
