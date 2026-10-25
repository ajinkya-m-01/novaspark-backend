import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabase } from "../supabase.js";

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

// ─── GET /api/user/dashboard ───────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const userId = req.user.id;
  try {
    // Fetch referral code first so we can count referrals by code
    const { data: profile } = await supabase
      .from("profiles")
      .select("referral_code")
      .eq("id", userId)
      .maybeSingle();

    const referralCode = profile?.referral_code ?? null;

    const [
      walletResult,
      stakingResult,
      rewardsResult,
      referralsResult,
      txResult,
      announcementsResult,
      unreadResult,
    ] = await Promise.all([
      // 1. Primary wallet address
      supabase
        .from("wallets")
        .select("address")
        .eq("user_id", userId)
        .eq("is_primary", true)
        .maybeSingle(),

      // 2. Active staking positions
      supabase
        .from("staking_positions")
        .select("amount")
        .eq("user_id", userId)
        .eq("status", "active"),

      // 3. Claimable rewards
      supabase
        .from("rewards")
        .select("amount")
        .eq("user_id", userId)
        .eq("status", "claimable"),

      // 4. Referrals (by referral code)
      referralCode
        ? supabase
            .from("profiles")
            .select("id, status", { count: "exact" })
            .eq("referred_by", referralCode)
        : Promise.resolve({ data: [], count: 0, error: null }),

      // 5. Last 4 transactions
      supabase
        .from("transactions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(4),

      // 6. Pinned-first published announcements
      supabase
        .from("announcements")
        .select("id, title, body, type, is_pinned, published_at")
        .eq("is_published", true)
        .order("is_pinned", { ascending: false })
        .order("published_at", { ascending: false })
        .limit(3),

      // 7. Unread notification count
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("read", false),
    ]);

    const activePositions = stakingResult.data ?? [];
    const totalStaked = activePositions.reduce((sum, p) => sum + Number(p.amount), 0);

    const claimableTotal = (rewardsResult.data ?? []).reduce(
      (sum, r) => sum + Number(r.amount),
      0,
    );

    const allReferrals = referralsResult.data ?? [];
    const verified = allReferrals.filter((r) => r.status === "active").length;
    const total = referralsResult.count ?? allReferrals.length;

    return res.json({
      ok: true,
      dashboard: {
        walletAddress: walletResult.data?.address ?? null,
        tokenBalance: "0",
        stakedBalance: totalStaked.toFixed(4),
        activePositions: activePositions.length,
        claimableRewards: claimableTotal.toFixed(4),
        referrals: {
          total,
          verified,
          pending: total - verified,
        },
        recentTransactions: txResult.data ?? [],
        announcements: announcementsResult.data ?? [],
        unreadNotifications: unreadResult.count ?? 0,
      },
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
});

export default router;
