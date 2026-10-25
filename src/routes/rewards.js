import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabase } from "../supabase.js";

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const recordClaimSchema = z.object({
  rewardIds: z.array(z.string().uuid()).min(1, "At least one reward ID required").max(100),
  claimTransactionHash: z.string().regex(TX_HASH_RE, "Invalid transaction hash"),
});

// ─── GET /api/user/rewards ──────────────────────────────────────────────────────
router.get("/", limiter, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data: rewards, error } = await supabase
      .from("rewards")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Rewards query error:", error.message);
      return res.status(500).json({ error: "Failed to fetch rewards" });
    }

    const rewardList = rewards ?? [];
    const totalEarned = rewardList.reduce((sum, r) => sum + Number(r.amount), 0);
    const claimable = rewardList
      .filter((r) => r.status === "claimable")
      .reduce((sum, r) => sum + Number(r.amount), 0);
    const claimed = rewardList
      .filter((r) => r.status === "claimed")
      .reduce((sum, r) => sum + Number(r.amount), 0);

    return res.json({
      ok: true,
      rewards: rewardList,
      summary: {
        totalEarned: totalEarned.toFixed(4),
        claimable: claimable.toFixed(4),
        claimed: claimed.toFixed(4),
      },
    });
  } catch (err) {
    console.error("Rewards GET error:", err);
    return res.status(500).json({ error: "Failed to fetch rewards" });
  }
});

// ─── POST /api/user/rewards/record-claim ───────────────────────────────────────
router.post("/record-claim", limiter, async (req, res) => {
  const parsed = recordClaimSchema.safeParse(req.body);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if (k && !fields[k]) fields[k] = issue.message;
    }
    return res.status(400).json({ error: "Invalid claim data", fields });
  }

  return res.status(503).json({error:"Reward contract receipt verification is not configured"});
});
export default router;
