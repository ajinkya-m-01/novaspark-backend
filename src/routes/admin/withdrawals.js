import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors, MAX_LIMIT } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(60);
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "processed"]).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

const reviewSchema = z
  .object({
    status: z.enum(["approved", "rejected"]),
    reason: z.string().min(10).optional(),
    tx_hash: z.string().regex(TX_HASH_RE, "Invalid transaction hash").optional(),
  })
  .refine((v) => v.status !== "rejected" || Boolean(v.reason), {
    message: "A reason is required when rejecting",
    path: ["reason"],
  })
  .refine((v) => v.status !== "approved" || Boolean(v.tx_hash), {
    message: "A transaction hash is required when approving",
    path: ["tx_hash"],
  });

// ─── GET /api/admin/withdrawals ──────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", fields: parseFieldErrors(parsed.error) });
  }
  const { status, search, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("withdrawal_requests")
      .select("*, profiles!withdrawal_requests_user_id_fkey(display_name, email)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (search) query = query.ilike("wallet_address", `%${search}%`);

    const { data: withdrawals, count, error } = await query;
    if (error) {
      console.error("Admin withdrawals query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch withdrawals" });
    }

    const total = count ?? 0;
    return res.json({
      ok: true,
      withdrawals: withdrawals ?? [],
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Admin withdrawals error:", err);
    return res.status(500).json({ error: "Failed to fetch withdrawals" });
  }
});

// ─── PATCH /api/admin/withdrawals/:id/review ─────────────────────────────────
router.patch("/:id/review", limiter, async (req, res) => {
  const result = reviewSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { status, reason, tx_hash } = result.data;
  const requestId = req.params.id;

  try {
    const { data: request } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (!request) {
      return res.status(404).json({ error: "Withdrawal request not found" });
    }
    if (request.status !== "pending") {
      return res.status(400).json({ error: "This request has already been reviewed" });
    }

    const { data: updated, error: updateError } = await supabase
      .from("withdrawal_requests")
      .update({
        status,
        reason: reason ?? null,
        tx_hash: tx_hash ?? null,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        processed_at: status === "approved" ? new Date().toISOString() : null,
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: "Failed to update withdrawal request" });
    }

    if (status === "approved") {
      await supabase.from("transactions").insert({
        user_id: request.user_id,
        type: "transfer_out",
        amount: request.amount,
        symbol: request.symbol,
        status: "confirmed",
        tx_hash,
        confirmed_at: new Date().toISOString(),
      });
    }

    await supabase.from("notifications").insert({
      user_id: request.user_id,
      title: status === "approved" ? "Withdrawal approved" : "Withdrawal rejected",
      message:
        status === "approved"
          ? `Your withdrawal of ${request.amount} ${request.symbol} has been processed.`
          : reason,
      type: status === "approved" ? "success" : "warning",
      link: "/transactions",
      link_type: "transaction",
    });

    await recordAdminAudit(req.user.id, "withdrawal_review", {
      targetUserId: request.user_id,
      reason,
      metadata: { request_id: requestId, status, tx_hash },
    });

    return res.json({ ok: true, withdrawal: updated });
  } catch (err) {
    console.error("Error in PATCH /admin/withdrawals/:id/review:", err);
    return res.status(500).json({ error: "Failed to review withdrawal request" });
  }
});

export default router;
