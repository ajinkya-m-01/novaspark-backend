import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors, MAX_LIMIT } from "./_helpers.js";

import { kycBucket } from "../../lib/storage.js";
import { checked } from "../../lib/user-panel.js";
const router = Router();
const limiter = adminLimiter(60);

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "resubmit"]).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

const reviewSchema = z
  .object({
    status: z.enum(["approved", "rejected", "resubmit"]),
    reason: z.string().min(10).optional(),
  })
  .refine((v) => v.status === "approved" || Boolean(v.reason), {
    message: "A reason is required when rejecting or requesting resubmission",
    path: ["reason"],
  });

// ─── GET /api/admin/kyc ──────────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", fields: parseFieldErrors(parsed.error) });
  }
  const { status, search, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("kyc_submissions")
      .select("*, profiles!kyc_submissions_user_id_fkey(display_name, email, country)", { count: "exact" })
      .order("submitted_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (search) query = query.ilike("full_name", `%${search}%`);

    const { data: submissions, count, error } = await query;
    if (error) {
      console.error("Admin KYC query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch KYC queue" });
    }

    const total = count ?? 0;
    return res.json({
      ok: true,
      submissions: submissions ?? [],
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Admin KYC error:", err);
    return res.status(500).json({ error: "Failed to fetch KYC queue" });
  }
});

// ─── GET /api/admin/kyc/:id ──────────────────────────────────────────────────
router.get("/:id", limiter, async (req, res) => {
  try {
    const { data: submission, error } = await supabase
      .from("kyc_submissions")
      .select("*, profiles!kyc_submissions_user_id_fkey(display_name, email, country, country_iso2, unique_user_id)")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error || !submission) {
      return res.status(404).json({ error: "KYC submission not found" });
    }

    for (const key of ["front_url","back_url","selfie_url"]) {
      if (submission[key] && !submission[key].startsWith("https://")) {
        const {data}=checked(await supabase.storage.from(kycBucket).createSignedUrl(submission[key],300));
        submission[key]=data.signedUrl;
      }
    }
    return res.json({ ok: true, submission });
  } catch (err) {
    console.error("Admin KYC detail error:", err);
    return res.status(500).json({ error: "Failed to fetch KYC submission" });
  }
});

// ─── PATCH /api/admin/kyc/:id/review ─────────────────────────────────────────
router.patch("/:id/review", limiter, async (req, res) => {
  const result = reviewSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { status, reason } = result.data;
  const submissionId = req.params.id;

  try {
    const { data: submission } = await supabase
      .from("kyc_submissions")
      .select("id, user_id")
      .eq("id", submissionId)
      .maybeSingle();

    if (!submission) {
      return res.status(404).json({ error: "KYC submission not found" });
    }

    const { data: updated, error: updateError } = await supabase
      .from("kyc_submissions")
      .update({
        status,
        reason: reason ?? null,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", submissionId)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: "Failed to update KYC submission" });
    }

    await supabase
      .from("profiles")
      .update({ kyc_status: status, updated_at: new Date().toISOString() })
      .eq("id", submission.user_id);

    const titles = {
      approved: "Your KYC has been approved",
      rejected: "Your KYC submission was rejected",
      resubmit: "Please resubmit your KYC documents",
    };
    await supabase.from("notifications").insert({
      user_id: submission.user_id,
      title: titles[status],
      message: reason ?? "Your identity verification has been approved.",
      type: status === "approved" ? "success" : "warning",
      link: "/kyc",
      link_type: "kyc",
    });

    await recordAdminAudit(req.user.id, "kyc_review", {
      targetUserId: submission.user_id,
      reason,
      metadata: { submission_id: submissionId, status },
    });

    return res.json({ ok: true, submission: updated });
  } catch (err) {
    console.error("Error in PATCH /admin/kyc/:id/review:", err);
    return res.status(500).json({ error: "Failed to review KYC submission" });
  }
});

export default router;
