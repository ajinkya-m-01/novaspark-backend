import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, parseFieldErrors } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(30);

const querySchema = z.object({
  type: z.enum(["users", "transactions", "staking", "referrals"]),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

function dateOnly(iso) {
  return iso.slice(0, 10);
}

function groupByDay(rows, dateField) {
  const counts = {};
  for (const row of rows) {
    const day = dateOnly(row[dateField]);
    counts[day] = (counts[day] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function buildUsersReport(from, to) {
  let query = supabase.from("profiles").select("id, created_at, status, kyc_status, country_iso2").neq("role", "admin");
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const byStatus = {};
  const byKycStatus = {};
  const byCountry = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byKycStatus[row.kyc_status] = (byKycStatus[row.kyc_status] ?? 0) + 1;
    if (row.country_iso2) byCountry[row.country_iso2] = (byCountry[row.country_iso2] ?? 0) + 1;
  }

  return {
    total: rows.length,
    byStatus,
    byKycStatus,
    byCountry,
    signupsByDay: groupByDay(rows, "created_at"),
    rows,
  };
}

async function buildTransactionsReport(from, to) {
  let query = supabase.from("transactions").select("id, created_at, type, status, amount, symbol, usd_value");
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const byType = {};
  const byStatus = {};
  let totalVolumeUsd = 0;
  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status === "confirmed") totalVolumeUsd += Number(row.usd_value ?? 0);
  }

  return {
    total: rows.length,
    totalVolumeUsd: totalVolumeUsd.toFixed(2),
    byType,
    byStatus,
    volumeByDay: groupByDay(rows, "created_at"),
    rows,
  };
}

async function buildStakingReport(from, to) {
  let query = supabase.from("staking_positions").select("id, created_at, lock_days, amount, earned, status");
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const byLockDays = {};
  const byStatus = {};
  let totalStaked = 0;
  let totalEarned = 0;
  for (const row of rows) {
    byLockDays[row.lock_days] = (byLockDays[row.lock_days] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    totalStaked += Number(row.amount ?? 0);
    totalEarned += Number(row.earned ?? 0);
  }

  return {
    total: rows.length,
    totalStaked: totalStaked.toFixed(4),
    totalEarned: totalEarned.toFixed(4),
    byLockDays,
    byStatus,
    positionsByDay: groupByDay(rows, "created_at"),
    rows,
  };
}

async function buildReferralsReport(from, to) {
  let query = supabase.from("profiles").select("id, created_at, sponsor_id, display_name, email").neq("role", "admin").not("sponsor_id", "is", null);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const bySponsor = {};
  for (const row of rows) {
    bySponsor[row.sponsor_id] = (bySponsor[row.sponsor_id] ?? 0) + 1;
  }

  const sponsorIds = Object.keys(bySponsor);
  let topReferrers = [];
  if (sponsorIds.length > 0) {
    const { data: sponsors } = await supabase.from("profiles").select("id, display_name, email").in("id", sponsorIds);
    topReferrers = (sponsors ?? [])
      .map((s) => ({ id: s.id, name: s.display_name ?? s.email, count: bySponsor[s.id] ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }

  return {
    total: rows.length,
    topReferrers,
    referralsByDay: groupByDay(rows, "created_at"),
    rows,
  };
}

// ─── GET /api/admin/reports ───────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", fields: parseFieldErrors(parsed.error) });
  }
  const { type, from, to } = parsed.data;

  try {
    let report;
    if (type === "users") report = await buildUsersReport(from, to);
    else if (type === "transactions") report = await buildTransactionsReport(from, to);
    else if (type === "staking") report = await buildStakingReport(from, to);
    else report = await buildReferralsReport(from, to);

    return res.json({ ok: true, type, from: from ?? null, to: to ?? null, report });
  } catch (err) {
    console.error("Admin report error:", err);
    return res.status(500).json({ error: "Failed to generate report" });
  }
});

export default router;
