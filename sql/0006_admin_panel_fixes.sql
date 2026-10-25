-- Fixes for columns referenced by admin panel routes but missing from the live DB.
-- presale_rounds pre-dated the `updated_at` column added to its CREATE TABLE text in
-- 0005_admin_panel.sql (CREATE TABLE IF NOT EXISTS is a no-op on an existing table).
-- roadmap's `category`/`date` ALTER statements in 0005_admin_panel.sql were never applied.

ALTER TABLE public.presale_rounds
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.roadmap
  ADD COLUMN IF NOT EXISTS date date,
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'general';

-- `quarter` is treated as optional by the admin create/edit form and its zod schema
-- (roadmap items can be milestone-based instead of quarter-based), but the original
-- schema.sql left it NOT NULL. Relax it to match the intended design.
ALTER TABLE public.roadmap
  ALTER COLUMN quarter DROP NOT NULL;
