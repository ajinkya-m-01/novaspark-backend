import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, parseFieldErrors, MAX_LIMIT } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(60);

const listQuerySchema = z.object({
  admin_id: z.string().uuid().optional(),
  action: z.string().trim().max(100).optional(),
  target_user_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

// ─── GET /api/admin/audit-log ────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", fields: parseFieldErrors(parsed.error) });
  }
  const { admin_id, action, target_user_id, from, to, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("admin_audit_log")
      .select("*, admin:profiles!admin_audit_log_admin_id_fkey(display_name, email), target:profiles!admin_audit_log_target_user_id_fkey(display_name, email)", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (admin_id) query = query.eq("admin_id", admin_id);
    if (action) query = query.eq("action", action);
    if (target_user_id) query = query.eq("target_user_id", target_user_id);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, count, error } = await query;
    if (error) {
      console.error("Admin audit log query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch audit log" });
    }

    const entries = (data ?? []).map((row) => ({
      ...row,
      admin_name: row.admin?.display_name ?? row.admin?.email ?? null,
      target_name: row.target?.display_name ?? row.target?.email ?? null,
    }));

    const total = count ?? 0;
    return res.json({
      ok: true,
      entries,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Admin audit log error:", err);
    return res.status(500).json({ error: "Failed to fetch audit log" });
  }
});

export default router;
