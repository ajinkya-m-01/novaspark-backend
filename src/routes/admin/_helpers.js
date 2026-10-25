import rateLimit from "express-rate-limit";
import { supabase } from "../../supabase.js";

export function adminLimiter(max = 60) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
  });
}

export async function recordAdminAudit(adminId, action, { targetUserId = null, reason = null, metadata = null } = {}) {
  try {
    await supabase.from("admin_audit_log").insert({
      admin_id: adminId,
      action,
      target_user_id: targetUserId,
      reason,
      metadata,
    });
  } catch (err) {
    console.warn("Admin audit log notice:", err?.message);
  }
}

export function parseFieldErrors(zodError) {
  const fields = {};
  for (const issue of zodError.issues) {
    const k = issue.path[0];
    if (k && !fields[k]) fields[k] = issue.message;
  }
  return fields;
}

export const MAX_LIMIT = 100;
