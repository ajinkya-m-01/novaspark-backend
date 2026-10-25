BEGIN;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL DEFAULT '{"transactions":false,"referrals":false,"governance":false,"news":false}';

ALTER TABLE public.support_messages ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]';
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS tx_hash text;
ALTER TABLE public.kyc_submissions
  ADD COLUMN IF NOT EXISTS document_type text DEFAULT 'passport',
  ADD COLUMN IF NOT EXISTS document_number text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS country text;
-- Existing admin schema uses drivers_license, front_url, back_url and reason.
ALTER TABLE public.kyc_submissions DROP CONSTRAINT IF EXISTS kyc_submissions_document_type_check;
UPDATE public.kyc_submissions SET document_type = 'driving_license' WHERE document_type = 'drivers_license';
ALTER TABLE public.kyc_submissions ADD CONSTRAINT kyc_submissions_document_type_check
  CHECK (document_type IN ('passport','national_id','driving_license'));
ALTER TABLE public.kyc_submissions ALTER COLUMN document_type SET DEFAULT 'passport';

CREATE TABLE IF NOT EXISTS public.membership_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  min_tokens numeric(36,18) NOT NULL DEFAULT 0,
  reward_bonus_bps integer NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT 'gray', icon text NOT NULL DEFAULT 'star',
  benefits jsonb DEFAULT '[]', created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_tiers_name_key ON public.membership_tiers(name);
INSERT INTO public.membership_tiers (name,min_tokens,reward_bonus_bps,color,icon,benefits) VALUES
 ('Bronze',100,0,'amber','award','["Access to staking","1-level referral bonus","Basic support"]'),
 ('Silver',500,200,'gray','award','["Bronze benefits","+2% staking bonus","Priority support"]'),
 ('Gold',2000,500,'yellow','crown','["Silver benefits","+5% staking bonus","Governance voting weight x2"]'),
 ('Platinum',5000,1000,'purple','diamond','["Gold benefits","+10% staking bonus","Early presale access","VIP support"]'),
 ('Diamond',10000,2000,'blue','gem','["Platinum benefits","+20% staking bonus","Advisory board access"]')
ON CONFLICT (name) DO NOTHING;
ALTER TABLE public.membership_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read tiers" ON public.membership_tiers;
CREATE POLICY "Anyone can read tiers" ON public.membership_tiers FOR SELECT USING (true);
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS note text, ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE public.withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
ALTER TABLE public.withdrawal_requests ADD CONSTRAINT withdrawal_requests_status_check
 CHECK (status IN ('pending','approved','rejected','processed','cancelled'));

-- All operations below are service-role only; serialize per user/ticket and commit atomically.
CREATE OR REPLACE FUNCTION public.user_panel_kyc_submit(uid uuid, payload jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE sid uuid;
BEGIN
 PERFORM 1 FROM profiles WHERE id=uid FOR UPDATE;
 IF EXISTS(SELECT 1 FROM kyc_submissions WHERE user_id=uid AND status IN ('pending','approved')) THEN RAISE EXCEPTION 'KYC_DUPLICATE'; END IF;
 INSERT INTO kyc_submissions(user_id,full_name,date_of_birth,country,document_type,document_number,address,front_url,back_url,selfie_url,status,submitted_at)
 VALUES(uid,payload->>'fullName',(payload->>'dateOfBirth')::date,payload->>'country',payload->>'documentType',payload->>'documentNumber',payload->>'address',payload->>'front',payload->>'back',payload->>'selfie','pending',now()) RETURNING id INTO sid;
 UPDATE profiles SET kyc_status='pending' WHERE id=uid;
 INSERT INTO notifications(user_id,title,message,type,link,link_type) VALUES(uid,'KYC submitted','KYC submitted successfully. We will review within 24-48 hours.','info','/kyc','kyc');
 RETURN sid;
END $$;
CREATE OR REPLACE FUNCTION public.user_panel_kyc_reset(uid uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE row kyc_submissions;
BEGIN
 PERFORM 1 FROM profiles WHERE id=uid FOR UPDATE;
 SELECT * INTO row FROM kyc_submissions WHERE user_id=uid ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF row.id IS NULL OR row.status NOT IN ('rejected','resubmit') THEN RAISE EXCEPTION 'KYC_RESET'; END IF;
 DELETE FROM kyc_submissions WHERE id=row.id;
 UPDATE profiles SET kyc_status='not_started' WHERE id=uid;
 RETURN jsonb_build_array(row.front_url,row.back_url,row.selfie_url);
END $$;
CREATE OR REPLACE FUNCTION public.user_panel_ticket_create(uid uuid, tid uuid, payload jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 PERFORM 1 FROM profiles WHERE id=uid FOR UPDATE;
 IF (SELECT count(*) FROM support_tickets WHERE user_id=uid AND status IN ('open','in_progress')) >= 5 THEN RAISE EXCEPTION 'OPEN_TICKET_LIMIT'; END IF;
 INSERT INTO support_tickets(id,user_id,subject,category,tx_hash) VALUES(tid,uid,payload->>'subject',payload->>'category',nullif(payload->>'txHash',''));
 INSERT INTO support_messages(ticket_id,sender_id,message,attachments) VALUES(tid,uid,payload->>'message',coalesce(payload->'attachments','[]'::jsonb));
 INSERT INTO notifications(user_id,title,message,type,link,link_type) VALUES(uid,'Support ticket created','Support ticket #'||tid||' created. We''ll respond within 24 hours.','info','/support/'||tid,'support');
 RETURN tid;
END $$;
CREATE OR REPLACE FUNCTION public.user_panel_ticket_reply(uid uuid, tid uuid, payload jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE row support_tickets; mid uuid;
BEGIN
 PERFORM 1 FROM profiles WHERE id=uid FOR UPDATE;
 SELECT * INTO row FROM support_tickets WHERE id=tid AND user_id=uid FOR UPDATE;
 IF row.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF row.status='closed' THEN RAISE EXCEPTION 'TICKET_CLOSED'; END IF;
 IF row.status='resolved' AND (SELECT count(*) FROM support_tickets WHERE user_id=uid AND status IN ('open','in_progress')) >= 5 THEN RAISE EXCEPTION 'OPEN_TICKET_LIMIT'; END IF;
 INSERT INTO support_messages(ticket_id,sender_id,message,attachments) VALUES(tid,uid,payload->>'message',coalesce(payload->'attachments','[]'::jsonb)) RETURNING id INTO mid;
 UPDATE support_tickets SET updated_at=now(),status=CASE WHEN status='resolved' THEN 'open' ELSE status END WHERE id=tid;
 RETURN mid;
END $$;
CREATE OR REPLACE FUNCTION public.user_panel_withdrawal_create(uid uuid, payload jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE kyc text; wid uuid;
BEGIN
 SELECT kyc_status INTO kyc FROM profiles WHERE id=uid FOR UPDATE;
 IF kyc IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'KYC_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM withdrawal_requests WHERE user_id=uid AND status='pending') THEN RAISE EXCEPTION 'WITHDRAWAL_PENDING'; END IF;
 IF (payload->>'amount')::numeric < 0.01 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
 INSERT INTO withdrawal_requests(user_id,amount,symbol,wallet_address,note,status) VALUES(uid,(payload->>'amount')::numeric,payload->>'symbol',payload->>'walletAddress',payload->>'note','pending') RETURNING id INTO wid;
 INSERT INTO notifications(user_id,title,message,type,link,link_type) VALUES(uid,'Withdrawal requested','Withdrawal request submitted. Processing within 1-3 business days.','info','/withdrawals','withdrawal');
 RETURN wid;
END $$;
REVOKE ALL ON FUNCTION public.user_panel_kyc_submit(uuid,jsonb), public.user_panel_kyc_reset(uuid), public.user_panel_ticket_create(uuid,uuid,jsonb), public.user_panel_ticket_reply(uuid,uuid,jsonb), public.user_panel_withdrawal_create(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_panel_kyc_submit(uuid,jsonb), public.user_panel_kyc_reset(uuid), public.user_panel_ticket_create(uuid,uuid,jsonb), public.user_panel_ticket_reply(uuid,uuid,jsonb), public.user_panel_withdrawal_create(uuid,jsonb) TO service_role;
-- Prevent bypassing the validated API with direct client inserts.
DROP POLICY IF EXISTS "Users insert own KYC submissions" ON public.kyc_submissions;
DROP POLICY IF EXISTS "Users insert own withdrawal requests" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Users insert own tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Users insert messages on own tickets" ON public.support_messages;
COMMIT;
