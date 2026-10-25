import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabase } from "../supabase.js";

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  pinned_only: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

// ─── GET /api/announcements ─────────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const { limit, pinned_only } = parsed.data;

  try {
    let query = supabase
      .from("announcements")
      .select("id, title, body, type, is_pinned, published_at, created_at")
      .eq("is_published", true)
      .order("is_pinned", { ascending: false })
      .order("published_at", { ascending: false })
      .limit(limit);

    if (pinned_only) {
      query = query.eq("is_pinned", true);
    }

    const { data: announcements, error } = await query;
    if (error) {
      console.error("Announcements query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch announcements" });
    }

    return res.json({ ok: true, announcements: announcements ?? [] });
  } catch (err) {
    console.error("Announcements error:", err);
    return res.status(500).json({ error: "Failed to fetch announcements" });
  }
});

export default router;
