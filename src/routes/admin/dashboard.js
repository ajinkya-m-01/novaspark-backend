import { Router } from "express";
import { supabase } from "../../supabase.js";
import { adminLimiter } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(30);

// ─── GET /api/admin/dashboard ───────────────────────────────────────────────
router.get("/", limiter, async (_req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

    const [
      totalUsersResult,
      newUsersTodayResult,
      kycPendingResult,
      tokensSoldResult,
      totalStakedResult,
      openTicketsResult,
      pendingWithdrawalsResult,
      revenueResult,
      signupsResult,
      activeRoundResult,
    ] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }).neq("role", "admin"),
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .neq("role", "admin")
        .gte("created_at", todayStart.toISOString()),
      supabase.from("profiles").select("id", { count: "exact", head: true }).eq("kyc_status", "pending"),
      supabase.from("presale_rounds").select("sold"),
      supabase.from("staking_positions").select("amount").eq("status", "active"),
      supabase.from("support_tickets").select("id", { count: "exact", head: true }).eq("status", "open"),
      supabase.from("withdrawal_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("transactions").select("usd_value").eq("status", "confirmed"),
      supabase
        .from("profiles")
        .select("created_at")
        .neq("role", "admin")
        .gte("created_at", sevenDaysAgo),
      supabase.from("presale_rounds").select("*").eq("status", "active").maybeSingle(),
    ]);

    const tokensSold = (tokensSoldResult.data ?? []).reduce((sum, r) => sum + Number(r.sold), 0);
    const totalStaked = (totalStakedResult.data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
    const revenueUsd = (revenueResult.data ?? []).reduce((sum, r) => sum + Number(r.usd_value ?? 0), 0);

    const signupsByDate = {};
    for (const row of signupsResult.data ?? []) {
      const day = row.created_at.slice(0, 10);
      signupsByDate[day] = (signupsByDate[day] ?? 0) + 1;
    }
    const signupsLast7Days = Object.entries(signupsByDate)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, count]) => ({ date, count }));

    return res.json({
      ok: true,
      stats: {
        totalUsers: totalUsersResult.count ?? 0,
        newUsersToday: newUsersTodayResult.count ?? 0,
        kycPending: kycPendingResult.count ?? 0,
        tokensSold: tokensSold.toFixed(4),
        totalStaked: totalStaked.toFixed(4),
        openTickets: openTicketsResult.count ?? 0,
        pendingWithdrawals: pendingWithdrawalsResult.count ?? 0,
        revenueUsd: revenueUsd.toFixed(2),
      },
      charts: {
        signupsLast7Days,
      },
      activeRound: activeRoundResult.data ?? null,
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
});

export default router;
