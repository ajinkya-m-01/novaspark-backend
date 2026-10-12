import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { supabase } from "../supabase.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

function maskDisplayName(name) {
  if (!name) return "Member";
  const clean = name.trim();
  if (clean.length <= 2) return clean[0] + "*";
  if (clean.includes("@")) {
    const [local, domain] = clean.split("@");
    return local.slice(0, 2) + "***@" + domain;
  }
  if (clean.includes(" ")) {
    const parts = clean.split(/\s+/);
    return parts[0].slice(0, 2) + "*** " + (parts[1] ? parts[1][0] + "." : "");
  }
  return clean.slice(0, 2) + "***" + clean.slice(-1);
}

// GET /api/user/profile
router.get("/profile", async (req, res) => {
  try {
    let { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    // If profile row doesn't exist yet, auto-provision it with stable referral code
    if (!profile) {
      const newRefCode = "NSP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      const defaultName = req.user.user_metadata?.display_name || req.user.email?.split("@")[0] || "Nova Member";
      const { data: createdProfile } = await supabase
        .from("profiles")
        .upsert({
          id: req.user.id,
          email: req.user.email,
          display_name: defaultName,
          referral_code: newRefCode,
          status: "active",
        })
        .select()
        .single();
      profile = createdProfile || {
        id: req.user.id,
        email: req.user.email,
        display_name: defaultName,
        referral_code: newRefCode,
        status: "active",
      };
    }

    const { count: referralCount } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("referred_by", profile?.referral_code || "");

    return res.json({
      ok: true,
      profile,
      referralCount: referralCount || 0,
    });
  } catch (err) {
    console.error("Error in GET /profile:", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// PATCH /api/user/profile
const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2, "Name must be at least 2 characters").max(50),
});

router.patch("/profile", async (req, res) => {
  const result = updateProfileSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Name must be 2 to 50 characters" });
  }

  try {
    const { error } = await supabase
      .from("profiles")
      .update({
        display_name: result.data.displayName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.user.id);

    if (error) {
      console.error("Error updating profile:", error);
      return res.status(500).json({ error: "Could not update profile" });
    }

    return res.json({ ok: true, displayName: result.data.displayName });
  } catch (err) {
    console.error("Error in PATCH /profile:", err);
    return res.status(500).json({ error: "Server error updating profile" });
  }
});

// GET /api/user/wallets
router.get("/wallets", async (req, res) => {
  try {
    const { data: wallets, error } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Notice: wallets table query returned:", error.message);
      return res.json({ ok: true, wallets: [] });
    }

    return res.json({ ok: true, wallets: wallets || [] });
  } catch (err) {
    return res.json({ ok: true, wallets: [] });
  }
});

// DELETE /api/user/wallets/:id
router.delete("/wallets/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("wallets")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) {
      console.warn("Notice: delete wallet error:", error.message);
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: true });
  }
});

// GET /api/user/notifications
router.get("/notifications", async (req, res) => {
  try {
    const { data: notifications, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.warn("Notice: notifications table query returned:", error.message);
      return res.json({ ok: true, notifications: [] });
    }

    return res.json({ ok: true, notifications: notifications || [] });
  } catch (err) {
    return res.json({ ok: true, notifications: [] });
  }
});

// PATCH /api/user/notifications/:id/read
router.patch("/notifications/:id/read", async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) {
      return res.status(500).json({ error: "Failed to mark notification as read" });
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/user/referrals
router.get("/referrals", async (req, res) => {
  try {
    let referralCode = "NSP-MEMBER";
    const { data: profile } = await supabase
      .from("profiles")
      .select("referral_code")
      .eq("id", req.user.id)
      .single();

    if (profile?.referral_code) {
      referralCode = profile.referral_code;
    } else {
      // Provision referral code if missing
      referralCode = "NSP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      await supabase
        .from("profiles")
        .update({ referral_code: referralCode })
        .eq("id", req.user.id);
    }

    const { data: referredUsers, count, error } = await supabase
      .from("profiles")
      .select("id, display_name, created_at, status", { count: "exact" })
      .eq("referred_by", referralCode)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.json({
        ok: true,
        referralCode,
        totalReferrals: 0,
        recentReferrals: [],
      });
    }

    // Mask display names to protect privacy
    const maskedReferrals = (referredUsers || []).map((u) => ({
      id: u.id,
      display_name: maskDisplayName(u.display_name),
      created_at: u.created_at,
      status: u.status || "Active",
    }));

    return res.json({
      ok: true,
      referralCode,
      totalReferrals: count || 0,
      recentReferrals: maskedReferrals,
    });
  } catch (err) {
    return res.json({
      ok: true,
      referralCode: "NSP-MEMBER",
      totalReferrals: 0,
      recentReferrals: [],
    });
  }
});

export default router;
