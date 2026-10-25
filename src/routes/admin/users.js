import { Router } from "express";
import { Resend } from "resend";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { config } from "../../config.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors, MAX_LIMIT } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(60);
const resend = new Resend(config.RESEND_API_KEY);

const SORTABLE = ["created_at", "display_name", "email", "status", "kyc_status"];

const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "suspended", "frozen", "blocked"]).optional(),
  role: z.enum(["user", "admin", "moderator"]).optional(),
  kyc_status: z.enum(["not_started", "pending", "approved", "rejected", "resubmit"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  sort_by: z.enum(SORTABLE).default("created_at"),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
});

const updateRoleSchema = z.object({
  role: z.enum(["user", "admin", "moderator"]),
  reason: z.string().min(10, "Reason must be at least 10 characters"),
});

const updateStatusSchema = z.object({
  status: z.enum(["active", "suspended", "frozen", "blocked"]),
  reason: z.string().min(10, "Reason must be at least 10 characters"),
});

const notifySchema = z.object({
  title: z.string().min(1).max(150),
  message: z.string().min(1).max(2000),
  type: z.enum(["info", "success", "warning", "error"]).default("info"),
});

// ─── GET /api/admin/users ────────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", fields: parseFieldErrors(parsed.error) });
  }
  const { search, status, role, kyc_status, page, limit, sort_by, sort_order } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("profiles")
      .select("id, email, display_name, unique_user_id, country, country_iso2, status, kyc_status, role, created_at, sponsor_id", { count: "exact" })
      .neq("role", "admin")
      .order(sort_by, { ascending: sort_order === "asc" })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (role) query = query.eq("role", role);
    if (kyc_status) query = query.eq("kyc_status", kyc_status);
    if (search) {
      query = query.or(
        `display_name.ilike.%${search}%,email.ilike.%${search}%,unique_user_id.ilike.%${search}%`,
      );
    }

    const { data: users, count, error } = await query;
    if (error) {
      console.error("Admin users query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch users" });
    }

    const rows = users ?? [];
    const ids = rows.map((u) => u.id);
    let referralCounts = {};
    if (ids.length > 0) {
      const { data: referrals } = await supabase
        .from("profiles")
        .select("sponsor_id")
        .in("sponsor_id", ids);
      for (const r of referrals ?? []) {
        referralCounts[r.sponsor_id] = (referralCounts[r.sponsor_id] ?? 0) + 1;
      }
    }

    const total = count ?? 0;
    return res.json({
      ok: true,
      users: rows.map((u) => ({ ...u, referral_count: referralCounts[u.id] ?? 0 })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Admin users error:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ─── GET /api/admin/users/:id ────────────────────────────────────────────────
router.get("/:id", limiter, async (req, res) => {
  const userId = req.params.id;
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error || !profile) {
      return res.status(404).json({ error: "User not found" });
    }

    const [walletsResult, kycResult, txResult, stakingResult, referralsResult, ticketsResult] =
      await Promise.all([
        supabase.from("wallets").select("*").eq("user_id", userId),
        supabase
          .from("kyc_submissions")
          .select("*")
          .eq("user_id", userId)
          .order("submitted_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("transactions")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase.from("staking_positions").select("*").eq("user_id", userId),
        supabase.from("profiles").select("id, display_name, email, status, created_at").eq("sponsor_id", userId),
        supabase
          .from("support_tickets")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
      ]);

    return res.json({
      ok: true,
      profile,
      wallets: walletsResult.data ?? [],
      kyc: kycResult.data ?? null,
      transactions: txResult.data ?? [],
      staking: stakingResult.data ?? [],
      referrals: referralsResult.data ?? [],
      tickets: ticketsResult.data ?? [],
    });
  } catch (err) {
    console.error("Admin user detail error:", err);
    return res.status(500).json({ error: "Failed to fetch user detail" });
  }
});

// ─── PATCH /api/admin/users/:id/status ───────────────────────────────────────
router.patch("/:id/status", limiter, async (req, res) => {
  const result = updateStatusSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { status, reason } = result.data;
  const targetId = req.params.id;

  try {
    const { data: current } = await supabase
      .from("profiles")
      .select("status, email, display_name")
      .eq("id", targetId)
      .single();

    if (!current) {
      return res.status(404).json({ error: "User not found" });
    }

    const { data: updated, error: updateError } = await supabase
      .from("profiles")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", targetId)
      .select()
      .single();

    if (updateError) {
      console.error("Error updating status:", updateError);
      return res.status(500).json({ error: "Failed to update status" });
    }

    await recordAdminAudit(req.user.id, "update_status", {
      targetUserId: targetId,
      reason,
      metadata: { old_status: current.status, new_status: status },
    });

    try {
      let subject = "";
      let body = "";

      if (status === "active") {
        subject = "Your account has been reactivated";
        body = `
          <p>Hello ${current.display_name || "there"},</p>
          <p>Your account has been reactivated and you can now sign in again.</p>
          <p>If you have any questions, please contact us at <a href="mailto:${config.EMAIL_FROM}">${config.EMAIL_FROM}</a>.</p>
        `;
      } else if (status === "suspended" || status === "frozen") {
        subject = "Your account status has changed";
        body = `
          <p>Hello ${current.display_name || "there"},</p>
          <p>Your account status has been changed to <strong>${status}</strong>.</p>
          <p>Please contact our support team for assistance: <a href="mailto:${config.EMAIL_FROM}">${config.EMAIL_FROM}</a>.</p>
        `;
      }

      if (subject && current.email) {
        await resend.emails.send({
          from: config.EMAIL_FROM,
          to: current.email,
          subject,
          html: `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;color:#374151;">${body}</body></html>`,
        });
      }
    } catch (emailErr) {
      console.warn("Could not send status change email:", emailErr?.message);
    }

    return res.json({ ok: true, profile: updated });
  } catch (err) {
    console.error("Error in PATCH /admin/users/:id/status:", err);
    return res.status(500).json({ error: "Failed to update user status" });
  }
});

// ─── PATCH /api/admin/users/:id/role ─────────────────────────────────────────
router.patch("/:id/role", limiter, async (req, res) => {
  const result = updateRoleSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { role, reason } = result.data;
  const targetId = req.params.id;

  try {
    const { data: current } = await supabase.from("profiles").select("role").eq("id", targetId).single();
    if (!current) {
      return res.status(404).json({ error: "User not found" });
    }

    const { data: updated, error: updateError } = await supabase
      .from("profiles")
      .update({ role, is_admin: role === "admin", updated_at: new Date().toISOString() })
      .eq("id", targetId)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: "Failed to update role" });
    }

    await recordAdminAudit(req.user.id, "update_role", {
      targetUserId: targetId,
      reason,
      metadata: { old_role: current.role, new_role: role },
    });

    return res.json({ ok: true, profile: updated });
  } catch (err) {
    console.error("Error in PATCH /admin/users/:id/role:", err);
    return res.status(500).json({ error: "Failed to update user role" });
  }
});

// ─── POST /api/admin/users/:id/notify ────────────────────────────────────────
router.post("/:id/notify", limiter, async (req, res) => {
  const result = notifySchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { title, message, type } = result.data;
  const targetId = req.params.id;

  try {
    const { data: target } = await supabase.from("profiles").select("id").eq("id", targetId).maybeSingle();
    if (!target) {
      return res.status(404).json({ error: "User not found" });
    }

    const { error: insertError } = await supabase.from("notifications").insert({
      user_id: targetId,
      title,
      message,
      type,
    });

    if (insertError) {
      return res.status(500).json({ error: "Failed to send notification" });
    }

    await recordAdminAudit(req.user.id, "notify_user", {
      targetUserId: targetId,
      metadata: { title, type },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in POST /admin/users/:id/notify:", err);
    return res.status(500).json({ error: "Failed to send notification" });
  }
});

export default router;
