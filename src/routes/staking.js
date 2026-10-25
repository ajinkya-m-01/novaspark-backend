import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabase } from "../supabase.js";

import { checked, validate, empty, userLimiter } from "../lib/user-panel.js";
const router = Router();
router.use(userLimiter(30,60_000));

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

const VALID_LOCK_DAYS = [30, 90, 180, 365];
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const recordStakeSchema = z.object({
  amount: z
    .string()
    .refine((v) => Number(v) > 0, "Amount must be greater than 0"),
  walletAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid wallet address"),
  lockDays: z.number().refine((v) => VALID_LOCK_DAYS.includes(v), `Lock days must be one of ${VALID_LOCK_DAYS.join(", ")}`),
  stakeTransactionHash: z.string().regex(TX_HASH_RE, "Invalid transaction hash"),
  rewardRate: z.number().min(0).max(100),
  symbol: z.string().min(1).max(20).default("TOKEN"),
});

const recordUnstakeSchema = z.object({
  positionId: z.string().uuid("Invalid position ID"),
  unstakeTransactionHash: z.string().regex(TX_HASH_RE, "Invalid transaction hash"),
});

// ─── GET /api/user/staking ──────────────────────────────────────────────────────
router.get("/", limiter, async (req, res, next) => {
  const userId = req.user.id;
  try {
    validate(empty, req.query);
    const [positionsResult, rewardsResult, configResult, globalResult] = await Promise.all([
      supabase
        .from("staking_positions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
      supabase
        .from("rewards")
        .select("amount, status")
        .eq("user_id", userId)
        .in("status", ["claimable", "claimed"]),
      supabase.from("staking_config").select("*").eq("is_active",true).order("lock_days"),
      supabase.from("staking_positions").select("amount").in("status",["active","unlocked"]),
    ]);

    [positionsResult,rewardsResult,configResult,globalResult].forEach(checked);
    const positions = positionsResult.data ?? [];
    const rewards = rewardsResult.data ?? [];

    const activePositions = positions.filter((p) => ["active","unlocked"].includes(p.status));
    const totalStaked = activePositions.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalEarned = positions.reduce((sum, p) => sum + Number(p.earned), 0);
    const pendingRewards = rewards
      .filter((r) => r.status === "claimable")
      .reduce((sum, r) => sum + Number(r.amount), 0);

    return res.json({
      ok: true,
      positions,
      availableBalance: "0",
      rewardsPoolBalance: String(pendingRewards),
      lockOptions: configResult.data ?? [],
      totalPoolStaked: String((globalResult.data ?? []).reduce((sum,p)=>sum+Number(p.amount),0)),
      contractConfigured: false,
      summary: {
        totalStaked: totalStaked.toFixed(4),
        activePositions: activePositions.length,
        totalEarned: totalEarned.toFixed(4),
        pendingRewards: pendingRewards.toFixed(4),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/user/staking/positions ───────────────────────────────────────────
router.get("/positions", limiter, async (req, res) => {
  const userId = req.user.id;
  const parsedQuery=z.object({status:z.enum(["active","unlocked","claimed","cancelled"]).optional()}).strict().safeParse(req.query);
  if(!parsedQuery.success)return res.status(400).json({error:"Invalid query parameters"});
  const status = parsedQuery.data.status;

  try {
    let query = supabase
      .from("staking_positions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (status && ["active", "unlocked", "claimed", "cancelled"].includes(status)) {
      query = query.eq("status", status);
    }

    const { data: positions, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Failed to fetch positions" });
    }

    return res.json({ ok: true, positions: positions ?? [] });
  } catch (err) {
    console.error("Positions GET error:", err);
    return res.status(500).json({ error: "Failed to fetch positions" });
  }
});

// ─── POST /api/user/staking/record ─────────────────────────────────────────────
router.post("/record", limiter, async (req, res) => {
  const parsed = recordStakeSchema.safeParse(req.body);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if (k && !fields[k]) fields[k] = issue.message;
    }
    return res.status(400).json({ error: "Invalid staking data", fields });
  }

  return res.status(503).json({ error: "Staking contract receipt verification is not configured" });
});

// ─── POST /api/user/staking/record-unstake ──────────────────────────────────────
router.post("/record-unstake", limiter, async (req, res) => {
  const parsed = recordUnstakeSchema.safeParse(req.body);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if (k && !fields[k]) fields[k] = issue.message;
    }
    return res.status(400).json({ error: "Invalid unstake data", fields });
  }

  return res.status(503).json({ error: "Staking contract receipt verification is not configured" });
});

export default router;
