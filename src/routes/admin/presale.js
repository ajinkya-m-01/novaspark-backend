import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(60);

const createRoundSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    price_usd: z.coerce.number().positive(),
    hard_cap: z.coerce.number().positive(),
    min_per_wallet: z.coerce.number().nonnegative(),
    max_per_wallet: z.coerce.number().positive(),
    start_time: z.string().datetime({ offset: true }),
    end_time: z.string().datetime({ offset: true }),
  })
  .refine((v) => v.min_per_wallet < v.max_per_wallet, {
    message: "min_per_wallet must be less than max_per_wallet",
    path: ["min_per_wallet"],
  })
  .refine((v) => new Date(v.end_time) > new Date(v.start_time), {
    message: "end_time must be after start_time",
    path: ["end_time"],
  });

const updateRoundSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  price_usd: z.coerce.number().positive().optional(),
  hard_cap: z.coerce.number().positive().optional(),
  min_per_wallet: z.coerce.number().nonnegative().optional(),
  max_per_wallet: z.coerce.number().positive().optional(),
  start_time: z.string().datetime({ offset: true }).optional(),
  end_time: z.string().datetime({ offset: true }).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["active", "paused", "ended"]),
});

// ─── GET /api/admin/presale/rounds ───────────────────────────────────────────
router.get("/rounds", limiter, async (_req, res) => {
  try {
    const { data: rounds, error } = await supabase
      .from("presale_rounds")
      .select("*")
      .order("round_number", { ascending: true });

    if (error) {
      return res.status(500).json({ error: "Failed to fetch presale rounds" });
    }

    return res.json({ ok: true, rounds: rounds ?? [] });
  } catch (err) {
    console.error("Admin presale rounds error:", err);
    return res.status(500).json({ error: "Failed to fetch presale rounds" });
  }
});

// ─── POST /api/admin/presale/rounds ──────────────────────────────────────────
router.post("/rounds", limiter, async (req, res) => {
  const result = createRoundSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  try {
    const { count } = await supabase.from("presale_rounds").select("id", { count: "exact", head: true });
    const { data: round, error } = await supabase
      .from("presale_rounds")
      .insert({ ...result.data, round_number: (count ?? 0) + 1, status: "upcoming" })
      .select()
      .single();

    if (error) {
      console.error("Create presale round error:", error.message);
      return res.status(500).json({ error: "Failed to create presale round" });
    }

    await recordAdminAudit(req.user.id, "presale_round_create", { metadata: { round_id: round.id } });

    return res.status(201).json({ ok: true, round });
  } catch (err) {
    console.error("Admin create presale round error:", err);
    return res.status(500).json({ error: "Failed to create presale round" });
  }
});

// ─── PATCH /api/admin/presale/rounds/:id ─────────────────────────────────────
router.patch("/rounds/:id", limiter, async (req, res) => {
  const result = updateRoundSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const roundId = req.params.id;

  try {
    const { data: current } = await supabase.from("presale_rounds").select("status").eq("id", roundId).maybeSingle();
    if (!current) {
      return res.status(404).json({ error: "Presale round not found" });
    }
    if (current.status === "ended") {
      return res.status(400).json({ error: "Cannot edit a round that has ended" });
    }

    const { data: round, error } = await supabase
      .from("presale_rounds")
      .update({ ...result.data, updated_at: new Date().toISOString() })
      .eq("id", roundId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to update presale round" });
    }

    await recordAdminAudit(req.user.id, "presale_round_update", { metadata: { round_id: roundId } });

    return res.json({ ok: true, round });
  } catch (err) {
    console.error("Admin update presale round error:", err);
    return res.status(500).json({ error: "Failed to update presale round" });
  }
});

// ─── PATCH /api/admin/presale/rounds/:id/status ──────────────────────────────
router.patch("/rounds/:id/status", limiter, async (req, res) => {
  const result = updateStatusSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { status } = result.data;
  const roundId = req.params.id;

  try {
    const { data: current } = await supabase.from("presale_rounds").select("status").eq("id", roundId).maybeSingle();
    if (!current) {
      return res.status(404).json({ error: "Presale round not found" });
    }

    if (status === "active") {
      await supabase.from("presale_rounds").update({ status: "paused" }).eq("status", "active");
    }

    const { data: round, error } = await supabase
      .from("presale_rounds")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", roundId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to update round status" });
    }

    await recordAdminAudit(req.user.id, "presale_round_status", {
      metadata: { round_id: roundId, old_status: current.status, new_status: status },
    });

    return res.json({ ok: true, round });
  } catch (err) {
    console.error("Admin presale status error:", err);
    return res.status(500).json({ error: "Failed to update round status" });
  }
});

export default router;
