import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { isValidPhoneNumber } from "libphonenumber-js";
import { supabase } from "../supabase.js";
import { requireAuth } from "../middleware/auth.js";

import { route,validate,checked,empty,userLimiter } from "../lib/user-panel.js";
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

// ─── GET /api/user/profile ─────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    if (!profile) {
      const newRefCode = "NSP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      const defaultName =
        req.user.user_metadata?.display_name ||
        req.user.email?.split("@")[0] ||
        "Member";
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
      return res.json({ ok: true, profile: createdProfile, referralCount: 0 });
    }

    const { count: referralCount } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("referred_by", profile?.referral_code || "");

    return res.json({ ok: true, profile, referralCount: referralCount || 0 });
  } catch (err) {
    console.error("Error in GET /profile:", err);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// ─── PATCH /api/user/profile ───────────────────────────────────────────────────
const updateProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50)
    .optional(),
  country: z.string().min(1).optional(),
  mobileNumber: z
    .string()
    .refine((v) => isValidPhoneNumber(v), "Invalid mobile number (E.164 format required)")
    .optional(),
  timezone: z.string().optional(),
});

router.patch("/profile", async (req, res) => {
  const result = updateProfileSchema.safeParse(req.body);
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) {
      const k = issue.path[0];
      if (k && !fields[k]) fields[k] = issue.message;
    }
    return res.status(400).json({ error: "Invalid profile data", fields });
  }

  const updates = {};
  if (result.data.displayName !== undefined) updates.display_name = result.data.displayName;
  // country, mobile_number, timezone are validated above but not yet in the DB schema
  updates.updated_at = new Date().toISOString();

  try {
    const { data: updated, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", req.user.id)
      .select("*")
      .single();

    if (error) {
      console.error("Error updating profile:", error);
      return res.status(500).json({ error: "Could not update profile" });
    }

    return res.json({ ok: true, displayName: updated.display_name, profile: updated });
  } catch (err) {
    console.error("Error in PATCH /profile:", err);
    return res.status(500).json({ error: "Server error updating profile" });
  }
});

// ─── GET /api/user/wallets ─────────────────────────────────────────────────────
router.get("/wallets", async (req, res) => {
  try {
    const { data: wallets, error } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Wallets query warning:", error.message);
      return res.json({ ok: true, wallets: [] });
    }
    return res.json({ ok: true, wallets: wallets || [] });
  } catch {
    return res.json({ ok: true, wallets: [] });
  }
});

// ─── DELETE /api/user/wallets/:id ─────────────────────────────────────────────
router.delete("/wallets/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("wallets")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) console.warn("Delete wallet warning:", error.message);
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
});

// ─── GET /api/user/notifications ──────────────────────────────────────────────
router.get("/notifications", async (req, res) => {
  const { type, unread_only } = req.query;
  try {
    let query = supabase
      .from("notifications")
      .select("id, title, message, type, read, created_at, link, link_type")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (type) query = query.eq("type", type);
    if (unread_only === "true") query = query.eq("read", false);

    const { data: notifications, error } = await query;
    if (error) {
      console.warn("Notifications query warning:", error.message);
      return res.json({ ok: true, notifications: [] });
    }
    return res.json({ ok: true, notifications: notifications || [] });
  } catch {
    return res.json({ ok: true, notifications: [] });
  }
});

// ─── PATCH /api/user/notifications/read-all ───────────────────────────────────
router.patch("/notifications/read-all", async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", req.user.id)
      .eq("read", false);
    if (error) return res.status(500).json({ error: "Failed to mark all as read" });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── PATCH /api/user/notifications/:id/read ───────────────────────────────────
router.patch("/notifications/:id/read", async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) return res.status(500).json({ error: "Failed to mark notification as read" });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "Server error" });
  }
});

const panelLimiter=userLimiter(60,60_000);
router.get("/portfolio",panelLimiter,route(async(req,res)=>{
 const {range}=validate(z.object({range:z.enum(["7D","30D","90D"])}).strict(),req.query);
 const since=new Date(Date.now()-Number(range.slice(0,-1))*86400000).toISOString();
 const {data}=checked(await supabase.from("portfolio_snapshots").select("total_value,recorded_at").eq("user_id",req.user.id).gte("recorded_at",since).order("recorded_at",{ascending:true}));
 res.json({ok:true,snapshots:data??[]});
}));
router.patch("/preferences",panelLimiter,route(async(req,res)=>{
 const prefs=validate(z.object({transactions:z.boolean(),referrals:z.boolean(),governance:z.boolean(),news:z.boolean()}).strict(),req.body);
 checked(await supabase.from("profiles").update({notification_preferences:prefs}).eq("id",req.user.id));res.json({ok:true});
}));
router.get("/referrals",panelLimiter,route(async(req,res)=>{
 validate(empty,req.query);
 const {data:profile}=checked(await supabase.from("profiles").select("referral_code").eq("id",req.user.id).single());
 const referralCode=profile.referral_code;
 const {data:users,count}=checked(await supabase.from("profiles").select("id,display_name,created_at,kyc_status",{count:"exact"}).eq("referred_by",referralCode).order("created_at",{ascending:false}));
 const {data:rewards}=checked(await supabase.from("rewards").select("amount").eq("user_id",req.user.id).eq("source","referral"));
 const verified=(users??[]).filter(u=>u.kyc_status==="approved").length;
 res.json({ok:true,referralCode,totalReferrals:count??0,verified,pending:(count??0)-verified,rewardsEarned:String((rewards??[]).reduce((n,r)=>n+Number(r.amount),0)),recentReferrals:(users??[]).map(u=>({...u,display_name:maskDisplayName(u.display_name)}))});
}));
export default router;
