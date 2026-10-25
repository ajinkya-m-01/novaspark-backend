import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors } from "./_helpers.js";

const router = Router();
const limiter = adminLimiter(60);

const currentQuarter = () => `Q${Math.ceil((new Date().getMonth() + 1) / 3)} ${new Date().getFullYear()}`;

const roadmapSchema = z.object({
  quarter: z.string().trim().min(1).max(20).default(currentQuarter),
  title: z.string().trim().min(1).max(150),
  description: z.string().max(2000).optional(),
  status: z.enum(["planned", "in-progress", "done"]).default("planned"),
  date: z.string().optional(),
  category: z.string().trim().max(50).default("general"),
  sort_order: z.coerce.number().int().default(0),
});

const teamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  bio: z.string().max(2000).optional(),
  avatar_url: z.string().url().optional().or(z.literal("")),
  linkedin_url: z.string().url().optional().or(z.literal("")),
  social_links: z.record(z.string(), z.string()).optional(),
  sort_order: z.coerce.number().int().default(0),
});

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(150),
  body: z.string().min(1).max(5000),
  type: z.enum(["general", "update", "alert", "maintenance"]).default("general"),
  is_pinned: z.boolean().default(false),
  is_published: z.boolean().default(false),
});

function buildResource(table, schema, label) {
  const sub = Router();

  sub.get("/", limiter, async (_req, res) => {
    const order = table === "announcements" ? "created_at" : "sort_order";
    const { data, error } = await supabase.from(table).select("*").order(order, { ascending: order !== "created_at" });
    if (error) return res.status(500).json({ error: `Failed to fetch ${label}` });
    return res.json({ ok: true, [table]: data ?? [] });
  });

  sub.post("/", limiter, async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(parsed.error) });
    }
    const payload = { ...parsed.data };
    if (table === "announcements" && payload.is_published) payload.published_at = new Date().toISOString();
    if (table === "announcements") payload.created_by = req.user.id;

    const { data, error } = await supabase.from(table).insert(payload).select().single();
    if (error) {
      console.error(`Create ${label} error:`, error.message);
      return res.status(500).json({ error: `Failed to create ${label}` });
    }
    await recordAdminAudit(req.user.id, `${table}_create`, { metadata: { id: data.id } });
    return res.status(201).json({ ok: true, item: data });
  });

  sub.patch("/:id", limiter, async (req, res) => {
    const parsed = schema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(parsed.error) });
    }
    const payload = { ...parsed.data };
    if (table === "announcements") {
      payload.updated_at = new Date().toISOString();
      if (payload.is_published) payload.published_at = new Date().toISOString();
    }

    const { data, error } = await supabase.from(table).update(payload).eq("id", req.params.id).select().single();
    if (error) return res.status(500).json({ error: `Failed to update ${label}` });
    if (!data) return res.status(404).json({ error: `${label} not found` });

    await recordAdminAudit(req.user.id, `${table}_update`, { metadata: { id: req.params.id } });
    return res.json({ ok: true, item: data });
  });

  sub.delete("/:id", limiter, async (req, res) => {
    const { error } = await supabase.from(table).delete().eq("id", req.params.id);
    if (error) return res.status(500).json({ error: `Failed to delete ${label}` });

    await recordAdminAudit(req.user.id, `${table}_delete`, { metadata: { id: req.params.id } });
    return res.json({ ok: true });
  });

  return sub;
}

router.use("/roadmap", buildResource("roadmap", roadmapSchema, "roadmap item"));
router.use("/team", buildResource("team", teamSchema, "team member"));
router.use("/announcements", buildResource("announcements", announcementSchema, "announcement"));

export default router;
