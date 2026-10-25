import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { adminLimiter, recordAdminAudit, parseFieldErrors, MAX_LIMIT } from "./_helpers.js";

import { signedAttachments } from "../../lib/storage.js";
const router = Router();
const limiter = adminLimiter(60);

const listQuerySchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigned_to: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

const updateTicketSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

const replySchema = z.object({
  message: z.string().min(1).max(5000),
  is_internal: z.boolean().default(false),
});

// ─── GET /api/admin/support/tickets ──────────────────────────────────────────
router.get("/tickets", limiter, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", fields: parseFieldErrors(parsed.error) });
  }
  const { status, priority, assigned_to, search, page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("support_tickets")
      .select("*, profiles!support_tickets_user_id_fkey(display_name, email)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (priority) query = query.eq("priority", priority);
    if (assigned_to) query = query.eq("assigned_to", assigned_to);
    if (search) query = query.ilike("subject", `%${search}%`);

    const { data: tickets, count, error } = await query;
    if (error) {
      console.error("Admin tickets query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch tickets" });
    }

    const total = count ?? 0;
    return res.json({
      ok: true,
      tickets: tickets ?? [],
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Admin tickets error:", err);
    return res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// ─── GET /api/admin/support/tickets/:id ──────────────────────────────────────
router.get("/tickets/:id", limiter, async (req, res) => {
  try {
    const [ticketResult, messagesResult] = await Promise.all([
      supabase
        .from("support_tickets")
        .select("*, profiles!support_tickets_user_id_fkey(display_name, email)")
        .eq("id", req.params.id)
        .maybeSingle(),
      supabase
        .from("support_messages")
        .select("*, profiles(display_name)")
        .eq("ticket_id", req.params.id)
        .order("created_at", { ascending: true }),
    ]);

    if (!ticketResult.data) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    return res.json({ ok: true, ticket: ticketResult.data, messages: await Promise.all((messagesResult.data ?? []).map(async m=>({...m,attachments:await signedAttachments(m.attachments ?? [])}))) });
  } catch (err) {
    console.error("Admin ticket detail error:", err);
    return res.status(500).json({ error: "Failed to fetch ticket" });
  }
});

// ─── PATCH /api/admin/support/tickets/:id ────────────────────────────────────
router.patch("/tickets/:id", limiter, async (req, res) => {
  const result = updateTicketSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  try {
    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .update({ ...result.data, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to update ticket" });
    }
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    await recordAdminAudit(req.user.id, "ticket_update", {
      targetUserId: ticket.user_id,
      metadata: { ticket_id: ticket.id, changes: result.data },
    });

    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error("Admin update ticket error:", err);
    return res.status(500).json({ error: "Failed to update ticket" });
  }
});

// ─── POST /api/admin/support/tickets/:id/reply ───────────────────────────────
router.post("/tickets/:id/reply", limiter, async (req, res) => {
  const result = replySchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid input", fields: parseFieldErrors(result.error) });
  }

  const { message, is_internal } = result.data;
  const ticketId = req.params.id;

  try {
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("id, user_id")
      .eq("id", ticketId)
      .maybeSingle();

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const { data: reply, error } = await supabase
      .from("support_messages")
      .insert({ ticket_id: ticketId, sender_id: req.user.id, message, is_internal })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to send reply" });
    }

    await supabase.from("support_tickets").update({ updated_at: new Date().toISOString() }).eq("id", ticketId);

    if (!is_internal) {
      await supabase.from("notifications").insert({
        user_id: ticket.user_id,
        title: "New reply on your support ticket",
        message: message.slice(0, 200),
        type: "info",
        link: `/support/${ticketId}`,
        link_type: "support",
      });
    }

    await recordAdminAudit(req.user.id, "ticket_reply", {
      targetUserId: ticket.user_id,
      metadata: { ticket_id: ticketId, is_internal },
    });

    return res.status(201).json({ ok: true, reply });
  } catch (err) {
    console.error("Admin ticket reply error:", err);
    return res.status(500).json({ error: "Failed to send reply" });
  }
});

export default router;
