-- 0003_indexes.sql
-- Safe additive performance and integrity indexes for NovaSpark
create index if not exists idx_profiles_referred_by on profiles(referred_by);
create index if not exists idx_profiles_referral_code on profiles(referral_code);
create index if not exists idx_wallets_address on wallets(address);
create index if not exists idx_wallets_user_id on wallets(user_id);
create index if not exists idx_notifications_user_id on notifications(user_id);
create index if not exists idx_audit_logs_user_id on audit_logs(user_id);
