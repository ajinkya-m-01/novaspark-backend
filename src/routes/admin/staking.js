import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(60);

const updateConfigSchema = z.object({
  reward_rate_bps: z.coerce.number().int().min(0).max(10000).optional(),
  is_active: z.boolean().optional(),
});

const createConfigSchema = z.object({
  lock_days: z.coerce.number().int().positive(),
  reward_rate_bps: z.coerce.number().int().min(0).max(10000),
});

// ─── GET /api/admin/staking/config ───────────────────────────────────────────
router.get("/config", limiter, async (_req, res) => {
  try {
    const { data: config, error } = await supabase
      .from("staking_config")
      .select("*")
      .order("lock_days", { ascending: true });

    if (error) {
      return res.status(500).json({ error: "Failed to fetch staking config" });
    }

    return res.json({ ok: true, config: config ?? [] });
  } catch (err) {
    console.error("Admin staking config error:", err);
    return res.status(500).json({ error: "Failed to fetch staking config" });
  }
});

// ─── POST /api/admin/staking/config ──────────────────────────────────────────
router.post("/config", limiter, async (req, res) => {
  const result = createConfigSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  try {
    const { data: config, error } = await supabase
      .from("staking_config")
      .insert({ ...result.data, is_active: true })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "A lock period with this duration already exists" });
      }
      return res.status(500).json({ error: "Failed to create staking config" });
    }

    await recordAdminAudit(req.user.id, "staking_config_create", { metadata: { config_id: config.id } });

    return res.status(201).json({ ok: true, config });
  } catch (err) {
    console.error("Admin create staking config error:", err);
    return res.status(500).json({ error: "Failed to create staking config" });
  }
});

// ─── PATCH /api/admin/staking/config/:id ─────────────────────────────────────
router.patch("/config/:id", limiter, async (req, res) => {
  const result = updateConfigSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  try {
    const { data: config, error } = await supabase
      .from("staking_config")
      .update({ ...result.data, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to update staking config" });
    }
    if (!config) {
      return res.status(404).json({ error: "Staking config not found" });
    }

    await recordAdminAudit(req.user.id, "staking_config_update", { metadata: { config_id: req.params.id } });

    return res.json({ ok: true, config });
  } catch (err) {
    console.error("Admin update staking config error:", err);
    return res.status(500).json({ error: "Failed to update staking config" });
  }
});

// ─── GET /api/admin/staking/stats ────────────────────────────────────────────
router.get("/stats", limiter, async (_req, res) => {
  try {
    const [positionsResult, rewardsPoolResult] = await Promise.all([
      supabase.from("staking_positions").select("amount, earned, status"),
      supabase.from("rewards").select("amount").eq("status", "claimable"),
    ]);

    const positions = positionsResult.data ?? [];
    const activePositions = positions.filter((p) => p.status === "active");
    const totalStaked = activePositions.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalEarned = positions.reduce((sum, p) => sum + Number(p.earned), 0);
    const rewardPoolBalance = (rewardsPoolResult.data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);

    return res.json({
      ok: true,
      stats: {
        totalStaked: totalStaked.toFixed(4),
        activePositions: activePositions.length,
        totalEarned: totalEarned.toFixed(4),
        rewardPoolBalance: rewardPoolBalance.toFixed(4),
      },
    });
  } catch (err) {
    console.error("Admin staking stats error:", err);
    return res.status(500).json({ error: "Failed to fetch staking stats" });
  }
});

export default router;
