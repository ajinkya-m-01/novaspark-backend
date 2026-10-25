import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { Resend } from "resend";
import { verifyMessage } from "viem";
import { z } from "zod";
import { isValidPhoneNumber } from "libphonenumber-js";
import { supabase, createAuthClient } from "../supabase.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { authLimiter, otpSendLimiter } from "../middleware/rateLimit.js";
import { RESTRICTED_COUNTRY_CODES } from "../config/restricted-countries.js";
import { config } from "../config.js";

const router = Router();
router.use(authLimiter);

const resend = new Resend(config.RESEND_API_KEY);

async function recordAuditLog(userId, action, details = {}, ip = null) {
  try {
    await supabase.from("audit_logs").insert({
      user_id: userId || null,
      action,
      details,
      ip_address: ip || null,
    });
  } catch (err) {
    console.warn("Audit log notice:", err?.message);
  }
}

function generateReferralCode() {
  return "NSP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function generateUniqueUserId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const uid = "UID" + String(crypto.randomInt(100000, 999999));
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .eq("unique_user_id", uid)
      .maybeSingle();
    if (!data) return uid;
  }
  throw new Error("Could not generate unique user ID");
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  displayName: z.string().trim().min(2, "Name must be at least 2 characters").max(50),
  email: z.string().trim().toLowerCase().email("Invalid email address").max(254),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100)
    .refine((v) => /[A-Z]/.test(v), "Password must contain an uppercase letter")
    .refine((v) => /[a-z]/.test(v), "Password must contain a lowercase letter")
    .refine((v) => /[0-9]/.test(v), "Password must contain a number")
    .refine((v) => /[^A-Za-z0-9]/.test(v), "Password must contain a special character"),
  mobileNumber: z
    .string()
    .refine((v) => isValidPhoneNumber(v), "Invalid mobile number (must be E.164 format)"),
  countryCode: z.string().min(2, "Country code required"),
  countryIso2: z.string().length(2).toUpperCase(),
  country: z.string().min(1, "Country name required"),
  timezone: z.string().default("UTC"),
  referralCode: z.string().trim().optional(),
  agreeTerms: z.literal(true, { errorMap: () => ({ message: "You must agree to the terms" }) }),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, "Password is required"),
});

const nonceSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM wallet address"),
});

const verifyWalletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM wallet address"),
  signature: z.string().startsWith("0x", "Invalid signature format"),
  message: z.string().optional(),
});

const otpSendSchema = z.object({
  destination: z.string().email("Valid email required"),
  type: z.enum(["registration", "login", "reset"]),
});

const otpVerifySchema = z.object({
  destination: z.string().email("Valid email required"),
  code: z.string().length(6).regex(/^\d{6}$/, "Code must be 6 digits"),
  type: z.string(),
});

// ─── POST /api/auth/register ───────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) {
      const k = issue.path[0];
      if (k && !fields[k]) fields[k] = issue.message;
    }
    return res.status(400).json({ error: "Invalid registration input", fields });
  }

  const {
    displayName,
    email,
    password,
    mobileNumber,
    countryCode,
    countryIso2,
    country,
    timezone,
    referralCode,
  } = result.data;

  try {
    // Check restricted country
    if (RESTRICTED_COUNTRY_CODES.includes(countryIso2)) {
      return res.status(403).json({ error: "Service not available in your country" });
    }

    // Resolve referral
    let sponsorId = null;
    let validReferredBy = null;
    if (referralCode && typeof referralCode === "string") {
      const cleanRef = referralCode.trim().toUpperCase();
      const { data: referrerProfile } = await supabase
        .from("profiles")
        .select("id, referral_code, email")
        .ilike("referral_code", cleanRef)
        .maybeSingle();

      if (referrerProfile) {
        if (referrerProfile.email?.toLowerCase() === email.toLowerCase()) {
          return res.status(400).json({ error: "You cannot use your own referral code" });
        }
        sponsorId = referrerProfile.id;
        validReferredBy = referrerProfile.referral_code;
      }
      // Unknown referral code: silently ignored (referredBy stays null)
    }

    // Create Supabase auth user
    const { data: adminData, error: adminError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName, referred_by: validReferredBy },
    });

    if (adminError) {
      if (adminError.message?.toLowerCase().includes("already registered")) {
        return res.status(400).json({ error: "An account with this email address already exists" });
      }
      console.error("createUser error:", adminError);
      return res.status(400).json({ error: adminError.message });
    }

    const userId = adminData.user.id;
    const refCode = generateReferralCode();

    // Insert profile (only columns that exist in the current schema)
    await supabase.from("profiles").upsert({
      id: userId,
      email,
      display_name: displayName,
      referral_code: refCode,
      referred_by: validReferredBy,
      status: "active",
    });

    // Welcome notification
    try {
      await supabase.from("notifications").insert({
        user_id: userId,
        title: `Welcome to ${config.BRAND_NAME}`,
        message: "Your account has been created. Connect your wallet to complete setup.",
        type: "success",
      });
    } catch (e) {
      console.warn("Could not insert welcome notification:", e?.message);
    }

    await recordAuditLog(userId, "auth.register", { email, referralCode: validReferredBy }, req.ip);

    // Auto sign-in immediately after registration
    let session = null;
    try {
      const authClient = createAuthClient();
      const { data: signInData } = await authClient.auth.signInWithPassword({ email, password });
      session = signInData?.session || null;
    } catch (e) {
      console.warn("Auto sign-in after registration failed:", e?.message);
    }

    return res.status(201).json({
      ok: true,
      user: {
        id: userId,
        email,
        displayName,
        referralCode: refCode,
        referredBy: validReferredBy,
      },
      session,
    });
  } catch (err) {
    console.error("Unexpected error in /register:", err);
    return res.status(500).json({ error: "Failed to create account" });
  }
});

// ─── POST /api/auth/login ──────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid email or password" });
  }

  const { email, password } = result.data;

  try {
    const authClient = createAuthClient();
    let { data, error } = await authClient.auth.signInWithPassword({ email, password });

    // Auto-confirm if needed
    if (error && error.message === "Email not confirmed") {
      try {
        const { data: userList } = await supabase.auth.admin.listUsers();
        const found = userList?.users?.find((u) => u.email === email);
        if (found) {
          await supabase.auth.admin.updateUserById(found.id, { email_confirm: true });
          const retryClient = createAuthClient();
          const retry = await retryClient.auth.signInWithPassword({ email, password });
          data = retry.data;
          error = retry.error;
        }
      } catch (e) {
        console.warn("Auto-confirm fallback:", e?.message);
      }
    }

    if (error || !data?.session) {
      return res.status(401).json({ error: error?.message || "Invalid credentials" });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    if (profile && profile.status !== "active") {
      return res.status(403).json({
        error: `Account ${profile.status}`,
        status: profile.status,
      });
    }

    await recordAuditLog(data.user.id, "auth.login", { email }, req.ip);

    return res.json({
      ok: true,
      session: data.session,
      user: data.user,
      profile: profile
        ? {
            ...profile,
            unique_user_id: profile.unique_user_id,
            status: profile.status,
            country_iso2: profile.country_iso2,
          }
        : null,
    });
  } catch (err) {
    console.error("Unexpected error in /login:", err);
    return res.status(500).json({ error: "Failed to sign in" });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    const { data: wallets } = await supabase
      .from("wallets")
      .select("id, address, chain_id, is_primary, verified_at")
      .eq("user_id", req.user.id);

    const { count: unreadNotifications } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .eq("read", false);

    return res.json({
      ok: true,
      user: req.user,
      profile: profile || {
        id: req.user.id,
        email: req.user.email,
        display_name: req.user.user_metadata?.display_name || req.user.email?.split("@")[0],
        referral_code: null,
        status: "active",
      },
      wallets: wallets || [],
      unreadNotifications: unreadNotifications || 0,
    });
  } catch (err) {
    console.error("Error in /me:", err);
    return res.status(500).json({ error: "Failed to fetch user state" });
  }
});

// ─── Nonce store ─────────────────────────────────────────────────────────────
const memoryNonces = new Map();

function saveNonce(address, nonce, expiresAt) {
  memoryNonces.set(address.toLowerCase(), {
    nonce,
    expiresAt: new Date(expiresAt).getTime(),
  });
  supabase
    .from("auth_nonces")
    .insert({ address: address.toLowerCase(), nonce, expires_at: expiresAt })
    .then(() => {})
    .catch(() => {});
}

async function getAndConsumeNonce(address) {
  const addr = address.toLowerCase();
  const mem = memoryNonces.get(addr);
  if (mem && mem.expiresAt > Date.now()) {
    memoryNonces.delete(addr);
    supabase.from("auth_nonces").delete().eq("address", addr).then(() => {}).catch(() => {});
    return mem.nonce;
  }

  try {
    const { data: nonces } = await supabase
      .from("auth_nonces")
      .select("*")
      .eq("address", addr)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1);

    if (nonces && nonces.length > 0) {
      await supabase.from("auth_nonces").delete().eq("id", nonces[0].id).catch(() => {});
      return nonces[0].nonce;
    }
  } catch {}
  return null;
}

// ─── POST /api/auth/nonce ─────────────────────────────────────────────────────
router.post("/nonce", async (req, res) => {
  const result = nonceSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Valid 0x wallet address required" });
  }

  const address = result.data.address.toLowerCase();
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  saveNonce(address, nonce, expiresAt);

  const domain = new URL(config.FRONTEND_URL).hostname;
  const issuedAt = new Date().toISOString();
  const message = [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    `Sign in to ${config.BRAND_NAME}`,
    "",
    `URI: ${config.FRONTEND_URL}`,
    `Version: 1`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");

  return res.json({ ok: true, nonce, message });
});

// ─── POST /api/auth/verify-wallet ─────────────────────────────────────────────
router.post("/verify-wallet", optionalAuth, async (req, res) => {
  const result = verifyWalletSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Valid address and signature required" });
  }

  const address = result.data.address.toLowerCase();
  const signature = result.data.signature;

  try {
    const activeNonce = await getAndConsumeNonce(address);
    if (!activeNonce) {
      return res.status(400).json({ error: "Session expired. Please request a new nonce." });
    }

    // Accept either a provided message (EIP-4361) or reconstruct it
    let expectedMessage = result.data.message;
    if (!expectedMessage) {
      const domain = new URL(config.FRONTEND_URL).hostname;
      expectedMessage = [
        `${domain} wants you to sign in with your Ethereum account:`,
        address,
        "",
        `Sign in to ${config.BRAND_NAME}`,
        "",
        `URI: ${config.FRONTEND_URL}`,
        `Version: 1`,
        `Nonce: ${activeNonce}`,
      ].join("\n");
    }

    const isValid = await verifyMessage({
      address,
      message: expectedMessage,
      signature,
    });

    if (!isValid) {
      return res.status(400).json({ error: "Cryptographic signature verification failed" });
    }

    const { data: existingWallet } = await supabase
      .from("wallets")
      .select("id, user_id, address")
      .eq("address", address)
      .maybeSingle();

    if (existingWallet && req.user?.id && existingWallet.user_id !== req.user.id) {
      return res.status(409).json({
        error: "This wallet address is already linked to another account.",
      });
    }

    let targetUserId = req.user?.id;
    let session = null;
    let user = req.user || null;

    if (!targetUserId) {
      const walletEmail = `${address}@wallet.${new URL(config.FRONTEND_URL).hostname}`;
      const walletPassword = `WLT_${address}_${config.JWT_SECRET.slice(0, 8)}!`;

      const authClient = createAuthClient();
      const { data: signInData } = await authClient.auth.signInWithPassword({
        email: walletEmail,
        password: walletPassword,
      });

      if (signInData?.session) {
        session = signInData.session;
        user = signInData.user;
        targetUserId = user.id;
      } else {
        const { data: createData } = await supabase.auth.admin.createUser({
          email: walletEmail,
          password: walletPassword,
          email_confirm: true,
          user_metadata: {
            display_name: `Wallet ${address.slice(0, 6)}...${address.slice(-4)}`,
            wallet_address: address,
          },
        });
        if (createData?.user) {
          user = createData.user;
          targetUserId = user.id;
          const retryClient = createAuthClient();
          const { data: retrySignIn } = await retryClient.auth.signInWithPassword({
            email: walletEmail,
            password: walletPassword,
          });
          session = retrySignIn?.session || null;
        }
      }
    }

    if (targetUserId) {
      try {
        await supabase.from("wallets").upsert(
          {
            user_id: targetUserId,
            address,
            chain_id: config.CHAIN_ID || 97,
            is_primary: true,
            verified_at: new Date().toISOString(),
          },
          { onConflict: "user_id,address,chain_id" }
        );
      } catch (err) {
        console.warn("Could not upsert wallet record:", err?.message);
      }

      await recordAuditLog(targetUserId, "wallet.verify", { address }, req.ip);
    }

    // Check account status if user exists
    if (targetUserId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("status")
        .eq("id", targetUserId)
        .maybeSingle();

      if (profile && profile.status !== "active") {
        return res.status(403).json({
          error: `Account ${profile.status}`,
          status: profile.status,
        });
      }
    }

    return res.json({ ok: true, address, verified: true, session, user });
  } catch (err) {
    console.error("Error verifying wallet signature:", err);
    return res.status(500).json({ error: "Failed to verify signature" });
  }
});

// ─── POST /api/auth/otp/send ──────────────────────────────────────────────────
router.post("/otp/send", otpSendLimiter, async (req, res) => {
  const result = otpSendSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]?.message || "Invalid input" });
  }

  const { destination, type } = result.data;

  try {
    // Check cooldown: if a non-consumed OTP was created < 60s ago, throttle
    const cooldownWindow = new Date(Date.now() - 60_000).toISOString();
    const { data: recentOtp } = await supabase
      .from("email_otps")
      .select("created_at")
      .eq("destination", destination)
      .eq("type", type)
      .eq("consumed", false)
      .gt("expires_at", new Date().toISOString())
      .gt("created_at", cooldownWindow)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentOtp) {
      const createdAt = new Date(recentOtp.created_at).getTime();
      const retryAfter = Math.ceil((createdAt + 60_000 - Date.now()) / 1000);
      return res.status(429).json({
        error: "Please wait before requesting another code",
        retryAfter,
      });
    }

    // Generate code
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase.from("email_otps").insert({
      destination,
      code_hash: codeHash,
      type,
      expires_at: expiresAt,
    });

    // Send email
    await resend.emails.send({
      from: config.EMAIL_FROM,
      to: destination,
      subject: "Your verification code",
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family:sans-serif;background:#f9f9f9;margin:0;padding:0;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;padding:40px 0;">
            <tr><td align="center">
              <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;border:1px solid #e5e7eb;">
                <tr><td>
                  <h2 style="margin:0 0 24px;font-size:20px;color:#111827;">Verification code</h2>
                  <p style="margin:0 0 24px;color:#374151;font-size:15px;">Use the code below to verify your identity:</p>
                  <div style="text-align:center;margin:32px 0;">
                    <span style="font-size:40px;font-weight:bold;letter-spacing:8px;color:#111827;font-family:monospace;">${code}</span>
                  </div>
                  <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">This code expires in <strong>10 minutes</strong>.</p>
                  <p style="margin:0;color:#6b7280;font-size:13px;">If you did not request this, you can safely ignore this email.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });

    return res.json({ success: true, expiresIn: 600 });
  } catch (err) {
    console.error("Error in /otp/send:", err);
    return res.status(500).json({ error: "Failed to send verification code" });
  }
});

// ─── POST /api/auth/otp/verify ─────────────────────────────────────────────────
router.post("/otp/verify", async (req, res) => {
  const result = otpVerifySchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues[0]?.message || "Invalid input" });
  }

  const { destination, code, type } = result.data;

  try {
    const { data: otp } = await supabase
      .from("email_otps")
      .select("*")
      .eq("destination", destination)
      .eq("type", type)
      .eq("consumed", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otp) {
      return res.status(400).json({ error: "No active OTP found. Please request a new code." });
    }

    // Increment attempts
    const newAttempts = otp.attempts + 1;
    await supabase
      .from("email_otps")
      .update({ attempts: newAttempts })
      .eq("id", otp.id);

    if (newAttempts > 5) {
      await supabase.from("email_otps").update({ consumed: true }).eq("id", otp.id);
      return res.status(429).json({ error: "Too many attempts. Please request a new code." });
    }

    const match = await bcrypt.compare(code, otp.code_hash);
    if (!match) {
      const attemptsRemaining = 5 - newAttempts;
      return res.status(400).json({ error: "Invalid code", attemptsRemaining });
    }

    await supabase.from("email_otps").update({ consumed: true }).eq("id", otp.id);
    return res.json({ verified: true });
  } catch (err) {
    console.error("Error in /otp/verify:", err);
    return res.status(500).json({ error: "Failed to verify code" });
  }
});

// ─── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required" });
  }
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${config.FRONTEND_URL}/reset-password`,
    });
    if (error) {
      console.warn("resetPasswordForEmail warning:", error.message);
      if (error.status === 429 || error.message?.toLowerCase().includes("rate limit")) {
        return res.status(429).json({ error: "Too many reset requests. Please wait before trying again." });
      }
    }
    await recordAuditLog(null, "auth.forgot_password", { email: email.trim().toLowerCase() }, req.ip);
    return res.json({
      ok: true,
      message: "If an account with that email exists, you will receive a reset link shortly.",
    });
  } catch (err) {
    console.error("Error in /forgot-password:", err);
    return res.status(500).json({ error: "Failed to initiate password reset" });
  }
});

// ─── POST /api/auth/reset-password ────────────────────────────────────────────
router.post("/reset-password", requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  try {
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password });
    if (error) {
      return res.status(400).json({ error: error.message || "Failed to update password" });
    }
    await recordAuditLog(req.user.id, "auth.reset_password", {}, req.ip);
    return res.json({ ok: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Error in /reset-password:", err);
    return res.status(500).json({ error: "Failed to update password" });
  }
});

// ─── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post("/logout", optionalAuth, async (req, res) => {
  if (req.user?.id) {
    try {
      await supabase.auth.admin.signOut(req.user.id);
    } catch (e) {
      console.warn("signOut warning:", e?.message);
    }
    await recordAuditLog(req.user.id, "auth.logout", {}, req.ip);
  }
  return res.json({ ok: true });
});

export default router;
