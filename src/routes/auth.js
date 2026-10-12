import { Router } from "express";
import crypto from "crypto";
import { verifyMessage } from "viem";
import { z } from "zod";
import { supabase, createAuthClient } from "../supabase.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

const router = Router();
router.use(authLimiter);

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

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address").max(254),
  password: z.string().min(6, "Password must be at least 6 characters").max(100),
  displayName: z.string().trim().min(2, "Name must be at least 2 characters").max(50).optional(),
  referralCode: z.string().trim().optional(),
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
});

function generateReferralCode() {
  return "NSP-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

// POST /api/auth/register
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

  const { email, password, displayName, referralCode } = result.data;

  try {
    const refCode = generateReferralCode();
    const name = displayName || email.split("@")[0];

    // Validate referral attribution on backend
    let validReferredBy = null;
    if (referralCode && typeof referralCode === "string") {
      const cleanRef = referralCode.trim().toUpperCase();
      try {
        const { data: referrerProfile } = await supabase
          .from("profiles")
          .select("id, referral_code, email")
          .eq("referral_code", cleanRef)
          .maybeSingle();

        if (referrerProfile) {
          // Prevent self-referral (cannot refer own email)
          if (referrerProfile.email?.toLowerCase() !== email.toLowerCase()) {
            validReferredBy = referrerProfile.referral_code;
          } else {
            console.warn(`Prevented self-referral attempt for email ${email} with code ${cleanRef}`);
          }
        } else {
          console.warn(`Referral code ${cleanRef} not found in database. Proceeding without attribution.`);
        }
      } catch (refErr) {
        console.warn("Notice: referral code lookup warning:", refErr?.message);
      }
    }

    let userId = null;
    let session = null;

    // Use admin.createUser to avoid Supabase SMTP/email send rate limits and ensure verified account
    const { data: adminData, error: adminError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: name,
        referred_by: validReferredBy,
      },
    });

    if (adminData?.user) {
      userId = adminData.user.id;
    } else if (adminError && adminError.message?.toLowerCase().includes("already registered")) {
      return res.status(400).json({ error: "An account with this email address already exists" });
    } else {
      // Fallback to standard signUp
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: name,
            referred_by: validReferredBy,
          },
        },
      });

      if (authError) {
        console.error("Supabase signUp error:", authError);
        return res.status(400).json({ error: authError.message });
      }

      userId = authData.user?.id;
      session = authData.session;
    }

    if (!userId) {
      return res.status(500).json({ error: "Failed to initialize user identity" });
    }

    // Acquire active session for immediate authenticated experience
    if (!session) {
      try {
        const authClient = createAuthClient();
        const { data: signInData } = await authClient.auth.signInWithPassword({ email, password });
        if (signInData?.session) {
          session = signInData.session;
        }
      } catch (e) {
        console.warn("Sign-in step notice:", e?.message);
      }
    }

    try {
      await supabase.from("profiles").upsert({
        id: userId,
        email,
        display_name: name,
        referral_code: refCode,
        referred_by: validReferredBy,
        status: "active",
      });
    } catch (e) {
      console.warn("Could not upsert profile:", e?.message);
    }

    try {
      const { error: notifError } = await supabase.from("notifications").insert({
        user_id: userId,
        title: "Welcome to NovaSpark",
        message: "Your account has been created. Connect your wallet to complete setup.",
        type: "success",
      });
      if (notifError) console.error("REGISTER NOTIF ERROR:", notifError);
    } catch (e) {
      console.warn("Could not insert welcome notification:", e?.message);
    }

    await recordAuditLog(userId, "auth.register", { email, referralCode: validReferredBy }, req.ip);

    return res.status(201).json({
      ok: true,
      user: {
        id: userId,
        email,
        displayName: name,
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

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Invalid email or password" });
  }

  const { email, password } = result.data;

  try {
    const authClient = createAuthClient();
    let { data, error } = await authClient.auth.signInWithPassword({
      email,
      password,
    });

    // Auto-confirm if needed for unconfirmed emails
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
        console.warn("Notice: auto-confirm fallback error:", e?.message);
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

    await recordAuditLog(data.user.id, "auth.login", { email }, req.ip);

    return res.json({
      ok: true,
      session: data.session,
      user: data.user,
      profile: profile || null,
    });
  } catch (err) {
    console.error("Unexpected error in /login:", err);
    return res.status(500).json({ error: "Failed to sign in" });
  }
});

// GET /api/auth/me
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
        referral_code: "NSP-MEMBER",
      },
      wallets: wallets || [],
      unreadNotifications: unreadNotifications || 0,
    });
  } catch (err) {
    console.error("Error in /me:", err);
    return res.status(500).json({ error: "Failed to fetch user state" });
  }
});

const memoryNonces = new Map();

function saveNonce(address, nonce, expiresAt) {
  memoryNonces.set(address.toLowerCase(), {
    nonce,
    expiresAt: new Date(expiresAt).getTime(),
  });
  // Also persist to Supabase if table exists
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

// POST /api/auth/nonce
router.post("/nonce", async (req, res) => {
  const result = nonceSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Valid 0x wallet address required" });
  }

  const address = result.data.address.toLowerCase();
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  saveNonce(address, nonce, expiresAt);

  const message = `Sign this message to authenticate with NovaSpark: ${nonce}`;
  return res.json({
    ok: true,
    nonce,
    message,
  });
});

// POST /api/auth/verify-wallet
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
      return res.status(400).json({ error: "No active challenge nonce found. Request a new nonce." });
    }

    const expectedMessage = `Sign this message to authenticate with NovaSpark: ${activeNonce}`;

    const isValid = await verifyMessage({
      address: address,
      message: expectedMessage,
      signature: signature,
    });

    if (!isValid) {
      return res.status(400).json({ error: "Cryptographic signature verification failed" });
    }

    // Prevent wallet conflict: cannot link a wallet already linked to another account
    const { data: existingWallet } = await supabase
      .from("wallets")
      .select("id, user_id, address")
      .eq("address", address)
      .maybeSingle();

    if (existingWallet && req.user?.id && existingWallet.user_id !== req.user.id) {
      return res.status(409).json({
        error: "This wallet address is already linked to another NovaSpark account. Please unlink it from that account first.",
      });
    }

    let targetUserId = req.user?.id;
    let session = null;
    let user = req.user || null;

    // If user is not already authenticated, perform 1-click Web3 login
    if (!targetUserId) {
      const walletEmail = `${address}@wallet.novaspark.io`;
      const walletPassword = `NSP_Wallet_${address}_AuthKey!`;

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
            chain_id: 56,
            is_primary: true,
            verified_at: new Date().toISOString(),
          },
          { onConflict: "user_id,address,chain_id" }
        );
      } catch (err) {
        console.warn("Could not upsert wallet record:", err?.message);
      }

      try {
        const { error: notifErr } = await supabase.from("notifications").insert({
          user_id: targetUserId,
          title: "Wallet Verified",
          message: `Wallet ${address.slice(0, 6)}...${address.slice(-4)} successfully verified on BNB Smart Chain.`,
          type: "success",
        });
        if (notifErr) console.error("WALLET NOTIF ERROR:", notifErr);
      } catch (err) {
        console.warn("Could not insert notification:", err?.message);
      }

      await recordAuditLog(targetUserId, "wallet.verify", { address, chainId: 56 }, req.ip);
    }

    return res.json({
      ok: true,
      address,
      verified: true,
      session,
      user,
    });
  } catch (err) {
    console.error("Error verifying wallet signature:", err);
    return res.status(500).json({ error: "Failed to verify signature" });
  }
});

// POST /api/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required" });
  }
  try {
    const origin = req.headers.origin || "http://localhost:8080";
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${origin}/reset-password`,
    });
    if (error) {
      console.warn("Notice: resetPasswordForEmail warning:", error.message);
      if (error.status === 429 || error.message?.toLowerCase().includes("rate limit")) {
        return res.status(429).json({ error: "Too many reset requests. Please wait a few minutes before trying again." });
      }
    }
    await recordAuditLog(null, "auth.forgot_password", { email: email.trim().toLowerCase() }, req.ip);
    return res.json({
      ok: true,
      message: "If an account exists for this email, password reset instructions have been sent.",
    });
  } catch (err) {
    console.error("Error in /forgot-password:", err);
    return res.status(500).json({ error: "Failed to initiate password reset" });
  }
});

// POST /api/auth/reset-password
router.post("/reset-password", requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
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

// POST /api/auth/logout
router.post("/logout", optionalAuth, async (req, res) => {
  if (req.user?.id) {
    await recordAuditLog(req.user.id, "auth.logout", {}, req.ip);
  }
  return res.json({ ok: true });
});

export default router;
