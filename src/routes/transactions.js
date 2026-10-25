import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabase } from "../supabase.js";

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

const TX_TYPES = ["buy", "sell", "stake", "unstake", "claim", "referral_bonus", "transfer_in", "transfer_out"];
const TX_STATUSES = ["pending", "confirmed", "failed"];
const MAX_LIMIT = 50;

const querySchema = z.object({
  type: z.enum(["buy", "sell", "stake", "unstake", "claim", "referral_bonus", "transfer_in", "transfer_out"]).optional(),
  status: z.enum(["pending", "confirmed", "failed"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(10),
  search: z.string().max(100).optional(),
});

// ─── GET /api/user/transactions ────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const { type, status, from, to, page, limit, search } = parsed.data;
  const offset = (page - 1) * limit;
  const userId = req.user.id;

  try {
    let query = supabase
      .from("transactions")
      .select("*", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) query = query.eq("type", type);
    if (status) query = query.eq("status", status);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    if (search) query = query.ilike("tx_hash", `%${search}%`);

    const { data: transactions, count, error } = await query;

    if (error) {
      console.error("Transactions query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch transactions" });
    }

    const total = count ?? 0;
    return res.json({
      ok: true,
      transactions: transactions ?? [],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Transactions error:", err);
    return res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ─── GET /api/user/transactions/export ─────────────────────────────────────────
router.get("/export", limiter, async (req, res) => {
  const parsed = querySchema.omit({ page: true, limit: true }).safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const { type, status, from, to, search } = parsed.data;
  const userId = req.user.id;

  try {
    let query = supabase
      .from("transactions")
      .select("created_at, type, amount, symbol, usd_value, status, tx_hash")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (type) query = query.eq("type", type);
    if (status) query = query.eq("status", status);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    if (search) query = query.ilike("tx_hash", `%${search}%`);

    const { data: rows, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Failed to export transactions" });
    }

    const csvCell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = "Date,Type,Amount,Symbol,USD Value,Status,TX Hash";
    const lines = (rows ?? []).map((tx) =>
      [
        tx.created_at,
        tx.type,
        tx.amount,
        tx.symbol,
        tx.usd_value ?? "",
        tx.status,
        tx.tx_hash ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="transactions.csv"');
    return res.send(csv);
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ error: "Failed to export transactions" });
  }
});

export default router;
