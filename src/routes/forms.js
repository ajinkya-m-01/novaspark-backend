import { Router } from "express";
import { supabase } from "../supabase.js";
import { contactLimiter, subscribeLimiter } from "../middleware/rateLimit.js";
import { contactSchema, subscribeSchema } from "../validators.js";

const router = Router();

function isHoneypotFilled(body) {
  if (!body || body.website === undefined || body.website === null) return false;
  return typeof body.website === "string" ? body.website.trim().length > 0 : Boolean(body.website);
}

function formatValidationErrors(issues) {
  const fields = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (key && !fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

router.post("/contact", contactLimiter, async (req, res) => {
  if (isHoneypotFilled(req.body)) {
    return res.status(200).json({ ok: true });
  }

  const result = contactSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: "Invalid input",
      fields: formatValidationErrors(result.error.issues),
    });
  }

  try {
    const { name, email, message } = result.data;
    const { error } = await supabase
      .from("contact_messages")
      .insert({ name, email, message });

    if (error) {
      console.error("Error inserting contact message:", error);
      return res.status(500).json({ error: "Could not send message" });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Unexpected error in /api/contact:", err);
    return res.status(500).json({ error: "Could not send message" });
  }
});

router.post("/subscribe", subscribeLimiter, async (req, res) => {
  if (isHoneypotFilled(req.body)) {
    return res.status(200).json({ ok: true });
  }

  const result = subscribeSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: "Invalid input",
      fields: formatValidationErrors(result.error.issues),
    });
  }

  try {
    const { email } = result.data;
    const { error } = await supabase
      .from("subscribers")
      .insert({ email });

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Already subscribed" });
      }
      console.error("Error inserting subscriber:", error);
      return res.status(500).json({ error: "Could not subscribe" });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Unexpected error in /api/subscribe:", err);
    return res.status(500).json({ error: "Could not subscribe" });
  }
});

export default router;
