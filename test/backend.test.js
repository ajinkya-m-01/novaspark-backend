import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { contactSchema, subscribeSchema } from "../src/validators.js";
import { supabase } from "../src/supabase.js";

const BASE = process.env.TEST_BASE_URL || "http://localhost:4000";

async function registerUser(label) {
  const email = `${label}_${Date.now()}@novaspark.io`;
  const reg = await (
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Password123!Secure",
        displayName: `${label} User`,
        mobileNumber: "+61412345678",
        countryCode: "+61",
        countryIso2: "AU",
        country: "Australia",
        agreeTerms: true,
      }),
    })
  ).json();
  return { email, token: reg.session.access_token, userId: reg.user.id };
}

async function registerAndPromoteAdmin(label) {
  const { email, token, userId } = await registerUser(label);
  const { error } = await supabase
    .from("profiles")
    .update({ role: "admin", is_admin: true })
    .eq("id", userId);
  if (error) throw error;
  return { email, token, userId };
}

test("Validators: contactSchema accepts valid input", () => {
  const valid = {
    name: "Alex Doe",
    email: "alex@example.com",
    message: "Interested in partnership and integration with your platform.",
  };
  const res = contactSchema.safeParse(valid);
  assert.equal(res.success, true);
});

test("Validators: contactSchema rejects missing fields and short message", () => {
  const invalid = {
    name: "",
    email: "notanemail",
    message: "hi",
  };
  const res = contactSchema.safeParse(invalid);
  assert.equal(res.success, false);
});

test("Validators: subscribeSchema validates email properly", () => {
  assert.equal(subscribeSchema.safeParse({ email: "user@novaspark.io" }).success, true);
  assert.equal(subscribeSchema.safeParse({ email: "bad-email" }).success, false);
});

test("Live API: GET /api/health returns ok", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test("Live API: GET /api/roadmap returns roadmap array", async () => {
  const res = await fetch(`${BASE}/api/roadmap`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length > 0);
});

test("Live API: GET /api/team returns team array", async () => {
  const res = await fetch(`${BASE}/api/team`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length > 0);
});

test("Live API: POST /api/auth/nonce generates valid challenge for 0x address", async () => {
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  const res = await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.nonce);
  assert.ok(data.message.includes(data.nonce));
});

test("Live API: Cryptographic signature verification via personal_sign", async () => {
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  // 1. Get nonce
  const nonceRes = await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();

  // 2. Sign message with private key
  const signature = await account.signMessage({ message: nonceData.message });

  // 3. Verify on backend
  const verifyRes = await fetch(`${BASE}/api/auth/verify-wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature: signature,
      message: nonceData.message,
    }),
  });

  assert.equal(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.ok, true);
  assert.equal(verifyData.verified, true);
});

test("Live API: Invalid signature is rejected", async () => {
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  // 1. Get nonce
  const nonceRes = await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();

  // 2. Sign with a DIFFERENT account
  const diffAccount = privateKeyToAccount(generatePrivateKey());
  const badSignature = await diffAccount.signMessage({ message: nonceData.message });

  // 3. Send mismatching address and signature
  const verifyRes = await fetch(`${BASE}/api/auth/verify-wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature: badSignature,
      message: nonceData.message,
    }),
  });

  assert.equal(verifyRes.status, 400);
  const verifyData = await verifyRes.json();
  assert.ok(verifyData.error.includes("verification failed"));
});

test("Live API & Supabase: Registration, Login, and Profile Lifecycle", async () => {
  const email = `test_runner_${Date.now()}@novaspark.io`;
  const password = "Password123!Secure";
  const displayName = "E2E Test Runner";

  // 1. Register
  const regRes = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName, mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  assert.equal(regData.ok, true);
  assert.ok(regData.user.id);
  assert.ok(regData.session?.access_token);

  const token = regData.session.access_token;

  // 2. Login
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.equal(loginData.ok, true);
  assert.equal(loginData.profile?.email, email);

  // 3. GET /me
  const meRes = await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.ok, true);
  assert.equal(meData.profile.display_name, displayName);

  // 4. Update profile name
  const patchRes = await fetch(`${BASE}/api/user/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ displayName: "Updated Runner Name" }),
  });
  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.displayName, "Updated Runner Name");

  // 5. Link wallet with personal_sign
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  const nonceRes = await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();
  const signature = await account.signMessage({ message: nonceData.message });

  const verifyRes = await fetch(`${BASE}/api/auth/verify-wallet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      address: account.address,
      signature: signature,
      message: nonceData.message,
    }),
  });
  assert.equal(verifyRes.status, 200);

  // 6. Check wallets list
  const walletsRes = await fetch(`${BASE}/api/user/wallets`, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(walletsRes.status, 200);
  const walletsData = await walletsRes.json();
  assert.ok(walletsData.wallets.some((w) => w.address.toLowerCase() === account.address.toLowerCase()));

  // 7. Check notifications list
  const notifsRes = await fetch(`${BASE}/api/user/notifications`, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(notifsRes.status, 200);
  const notifsData = await notifsRes.json();
  assert.ok(notifsData.notifications.length >= 1);
});

test("Live API & Supabase: 1-Click Web3 Wallet Login", async () => {
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  // 1. Get nonce
  const nonceRes = await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();

  // 2. Sign challenge
  const signature = await account.signMessage({ message: nonceData.message });

  // 3. Verify WITHOUT Bearer token
  const verifyRes = await fetch(`${BASE}/api/auth/verify-wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature: signature,
      message: nonceData.message,
    }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.ok, true);
  assert.equal(verifyData.verified, true);
  assert.ok(verifyData.session?.access_token);
  assert.ok(verifyData.user?.id);
});

test("Live API & Supabase: Referral Attribution, Validation & Privacy Masking", async () => {
  const timestamp = Date.now();
  const emailA = `ref_referrer_${timestamp}@novaspark.io`;
  const emailB = `ref_referee_${timestamp}@novaspark.io`;
  const password = "Password123!Secure";

  // 1. Register User A (Referrer)
  const regARes = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailA, password, displayName: "Referrer Alpha", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  });
  assert.equal(regARes.status, 201);
  const regAData = await regARes.json();
  const codeA = regAData.user.referralCode;
  const tokenA = regAData.session.access_token;
  assert.ok(codeA.startsWith("NSP-"));

  // 2. Register User B using User A's referral code
  const regBRes = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: emailB,
      password,
      displayName: "Referee Beta",
      referralCode: codeA,
      mobileNumber: "+61412345678",
      countryCode: "+61",
      countryIso2: "AU",
      country: "Australia",
      agreeTerms: true,
    }),
  });
  assert.equal(regBRes.status, 201);
  const regBData = await regBRes.json();
  assert.equal(regBData.user.referredBy, codeA);

  // 3. Verify User A's referral dashboard
  const refRes = await fetch(`${BASE}/api/user/referrals`, {
    headers: { Authorization: "Bearer " + tokenA },
  });
  assert.equal(refRes.status, 200);
  const refData = await refRes.json();
  assert.equal(refData.ok, true);
  assert.ok(refData.totalReferrals >= 1);
  assert.ok(refData.recentReferrals.length >= 1);

  // Verify privacy masking on referred users
  const recentMember = refData.recentReferrals[0];
  assert.ok(!recentMember.display_name.includes("Referee Beta"), "Full name should be masked for privacy");
  assert.ok(recentMember.display_name.includes("***"), "Display name should contain masking asterisks");

  // 4. Test invalid / unknown referral code handling: gracefully ignored
  const emailC = `ref_unknown_${timestamp}@novaspark.io`;
  const regCRes = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: emailC,
      password,
      displayName: "Normal User",
      referralCode: "NSP-NONEXISTENT999",
      mobileNumber: "+61412345678",
      countryCode: "+61",
      countryIso2: "AU",
      country: "Australia",
      agreeTerms: true,
    }),
  });
  assert.equal(regCRes.status, 201);
  const regCData = await regCRes.json();
  assert.equal(regCData.user.referredBy, null);
});

test("Live API & Supabase: Wallet Multi-Account Conflict Prevention & Unlink", async () => {
  const timestamp = Date.now();
  const emailA = `wallet_user_a_${timestamp}@novaspark.io`;
  const emailB = `wallet_user_b_${timestamp}@novaspark.io`;
  const password = "Password123!Secure";

  // Register User A
  const regA = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailA, password, displayName: "User Alpha", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const tokenA = regA.session.access_token;

  // Register User B
  const regB = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailB, password, displayName: "User Beta", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const tokenB = regB.session.access_token;

  // Generate a dedicated test wallet
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  // User A links the wallet
  const nonceResA = await (await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json();
  const sigA = await account.signMessage({ message: nonceResA.message });

  const linkResA = await fetch(`${BASE}/api/auth/verify-wallet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tokenA,
    },
    body: JSON.stringify({ address: account.address, signature: sigA, message: nonceResA.message }),
  });
  assert.equal(linkResA.status, 200);

  // User B tries to link the SAME wallet -> Must return 409 Conflict
  const nonceResB = await (await fetch(`${BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json();
  const sigB = await account.signMessage({ message: nonceResB.message });

  const linkResB = await fetch(`${BASE}/api/auth/verify-wallet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tokenB,
    },
    body: JSON.stringify({ address: account.address, signature: sigB, message: nonceResB.message }),
  });
  assert.equal(linkResB.status, 409);
  const conflictData = await linkResB.json();
  assert.ok(conflictData.error.includes("already linked to another account"));

  // User A unlinks the wallet
  const walletsResA = await (await fetch(`${BASE}/api/user/wallets`, {
    headers: { Authorization: "Bearer " + tokenA },
  })).json();
  const walletRecord = walletsResA.wallets.find((w) => w.address.toLowerCase() === account.address.toLowerCase());
  assert.ok(walletRecord);

  const unlinkRes = await fetch(`${BASE}/api/user/wallets/${walletRecord.id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + tokenA },
  });
  assert.equal(unlinkRes.status, 200);

  // Verify wallet is removed from User A
  const afterWalletsA = await (await fetch(`${BASE}/api/user/wallets`, {
    headers: { Authorization: "Bearer " + tokenA },
  })).json();
  assert.ok(!afterWalletsA.wallets.some((w) => w.id === walletRecord.id));
});

test("Live API & Supabase: Notification Read Action & Persistence", async () => {
  const timestamp = Date.now();
  const email = `notif_user_${timestamp}@novaspark.io`;
  const password = "Password123!Secure";

  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName: "Notif Test User", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;

  // Fetch notifications
  const notifsRes = await fetch(`${BASE}/api/user/notifications`, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(notifsRes.status, 200);
  const notifsData = await notifsRes.json();
  assert.ok(notifsData.notifications.length >= 1);
  const notif = notifsData.notifications[0];
  assert.equal(notif.read, false);

  // Mark as read
  const markRes = await fetch(`${BASE}/api/user/notifications/${notif.id}/read`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(markRes.status, 200);

  // Verify persistence on fresh fetch
  const refetchedRes = await fetch(`${BASE}/api/user/notifications`, {
    headers: { Authorization: "Bearer " + token },
  });
  const refetchedData = await refetchedRes.json();
  const updatedNotif = refetchedData.notifications.find((n) => n.id === notif.id);
  assert.equal(updatedNotif.read, true);
});

test("Live API: Password Reset and Forgot Password Endpoints", async () => {
  const timestamp = Date.now();
  const email = `pwd_reset_${timestamp}@novaspark.io`;
  const oldPassword = "Password123!Old";
  const newPassword = "Password123!NewUpdated";

  // Register user
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: oldPassword, displayName: "Password Reset User", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;

  // Forgot password request: accepts 200 (if SMTP quota available) or 429 (if Supabase free SMTP rate-limit reached)
  const forgotRes = await fetch(`${BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.ok(
    forgotRes.status === 200 || forgotRes.status === 429,
    `Expected 200 (success) or 429 (Supabase SMTP rate limit), got ${forgotRes.status}`
  );
  const forgotData = await forgotRes.json();
  assert.ok(forgotData.ok || forgotData.error);

  // Reset password while authenticated
  const resetRes = await fetch(`${BASE}/api/auth/reset-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ password: newPassword }),
  });
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.equal(resetData.ok, true);

  // Login with new password
  const newLoginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword }),
  });
  assert.equal(newLoginRes.status, 200);
  const newLoginData = await newLoginRes.json();
  assert.equal(newLoginData.ok, true);
});

test("Live API: Unauthenticated Access Rejection", async () => {
  const unauthEndpoints = [
    { url: `${BASE}/api/auth/me`, method: "GET" },
    { url: `${BASE}/api/user/profile`, method: "GET" },
    { url: `${BASE}/api/user/wallets`, method: "GET" },
    { url: `${BASE}/api/user/notifications`, method: "GET" },
    { url: `${BASE}/api/user/referrals`, method: "GET" },
    { url: `${BASE}/api/auth/reset-password`, method: "POST" },
  ];

  for (const ep of unauthEndpoints) {
    const res = await fetch(ep.url, { method: ep.method });
    assert.equal(res.status, 401, `Endpoint ${ep.url} should reject unauthenticated request`);
  }
});

test("Live API & Supabase: Contact Form Validation & Submission", async () => {
  const timestamp = Date.now();

  // Valid submission
  const validRes = await fetch(`${BASE}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E Tester",
      email: `contact_${timestamp}@example.com`,
      message: "Testing the platform contact form persistence and validation.",
    }),
  });
  assert.equal(validRes.status, 201);
  const validData = await validRes.json();
  assert.equal(validData.ok, true);

  // Invalid submission: message too short
  const shortRes = await fetch(`${BASE}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Tester",
      email: `test_${timestamp}@example.com`,
      message: "hi",
    }),
  });
  assert.equal(shortRes.status, 400);
});

test("Live API & Supabase: Newsletter Subscription & Deduplication", async () => {
  const timestamp = Date.now();
  const subEmail = `newsletter_${timestamp}@novaspark.io`;

  // First subscription
  const sub1 = await fetch(`${BASE}/api/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: subEmail }),
  });
  assert.equal(sub1.status, 201);
  const data1 = await sub1.json();
  assert.equal(data1.ok, true);

  // Duplicate subscription handled cleanly
  const sub2 = await fetch(`${BASE}/api/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: subEmail }),
  });
  assert.equal(sub2.status, 409);
  const data2 = await sub2.json();
  assert.equal(data2.error, "Already subscribed");
});

// ─── New route tests ────────────────────────────────────────────────────────────

test("Live API: GET /api/announcements returns ok with announcements array (public)", async () => {
  const res = await fetch(`${BASE}/api/announcements`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.announcements));
});

test("Live API: GET /api/announcements pinned_only filter works", async () => {
  const res = await fetch(`${BASE}/api/announcements?pinned_only=true`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.announcements));
  assert.ok(data.announcements.every((a) => a.is_pinned === true));
});

test("Live API: Unauthenticated access to new protected routes is rejected", async () => {
  const endpoints = [
    { url: `${BASE}/api/user/dashboard`, method: "GET" },
    { url: `${BASE}/api/user/transactions`, method: "GET" },
    { url: `${BASE}/api/user/staking`, method: "GET" },
    { url: `${BASE}/api/user/rewards`, method: "GET" },
    { url: `${BASE}/api/user/staking/record`, method: "POST" },
    { url: `${BASE}/api/user/rewards/record-claim`, method: "POST" },
  ];
  for (const ep of endpoints) {
    const res = await fetch(ep.url, { method: ep.method });
    assert.equal(res.status, 401, `${ep.url} should return 401`);
  }
});

test("Live API: POST /api/user/staking/record validates body schema (auth required)", async () => {
  // Register a user to get a valid token
  const email = `stk_val_${Date.now()}@novaspark.io`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!Secure", displayName: "Stk Tester", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;

  // Missing required fields
  const res = await fetch(`${BASE}/api/user/staking/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ amount: "1000", lockDays: 999 }), // invalid lockDays
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test("Live API: POST /api/user/rewards/record-claim validates body schema (auth required)", async () => {
  const email = `rwd_val_${Date.now()}@novaspark.io`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!Secure", displayName: "Rwd Tester", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;

  // Invalid rewardIds (not UUIDs)
  const res = await fetch(`${BASE}/api/user/rewards/record-claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ rewardIds: ["not-a-uuid"], claimTransactionHash: "0x" + "a".repeat(64) }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test("Live API & Supabase: Dashboard, Transactions, Staking, Rewards endpoints authenticated lifecycle", async () => {
  const email = `dash_${Date.now()}@novaspark.io`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!Secure", displayName: "Dash Tester", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;
  const headers = { Authorization: "Bearer " + token };

  // Dashboard
  const dashRes = await fetch(`${BASE}/api/user/dashboard`, { headers });
  assert.equal(dashRes.status, 200);
  const dashData = await dashRes.json();
  assert.equal(dashData.ok, true);
  assert.ok(dashData.dashboard);
  assert.ok(typeof dashData.dashboard.stakedBalance === "string");
  assert.ok(dashData.dashboard.referrals);

  // Transactions
  const txRes = await fetch(`${BASE}/api/user/transactions`, { headers });
  assert.equal(txRes.status, 200);
  const txData = await txRes.json();
  assert.equal(txData.ok, true);
  assert.ok(Array.isArray(txData.transactions));
  assert.ok(typeof txData.total === "number");

  // Staking
  const stkRes = await fetch(`${BASE}/api/user/staking`, { headers });
  assert.equal(stkRes.status, 200);
  const stkData = await stkRes.json();
  assert.equal(stkData.ok, true);
  assert.ok(Array.isArray(stkData.positions));
  assert.ok(stkData.summary);

  // Rewards
  const rwdRes = await fetch(`${BASE}/api/user/rewards`, { headers });
  assert.equal(rwdRes.status, 200);
  const rwdData = await rwdRes.json();
  assert.equal(rwdData.ok, true);
  assert.ok(Array.isArray(rwdData.rewards));
  assert.ok(rwdData.summary);
});

test("Live API: GET /api/user/transactions/export returns CSV (auth required)", async () => {
  const email = `txexp_${Date.now()}@novaspark.io`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!Secure", displayName: "Exp Tester", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;

  const res = await fetch(`${BASE}/api/user/transactions/export`, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/csv"));
});

test("Live API: PATCH /api/user/notifications/read-all marks all as read", async () => {
  const email = `readall_${Date.now()}@novaspark.io`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!Secure", displayName: "ReadAll User", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;
  const headers = { Authorization: "Bearer " + token };

  // Mark all as read
  const patchRes = await fetch(`${BASE}/api/user/notifications/read-all`, {
    method: "PATCH",
    headers,
  });
  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.ok, true);

  // Verify no unread remain
  const notifsRes = await fetch(`${BASE}/api/user/notifications?unread_only=true`, { headers });
  const notifsData = await notifsRes.json();
  assert.equal(notifsData.notifications.length, 0);
});

test("Live API: GET /api/user/notifications filters by type and unread_only", async () => {
  const email = `notiffilter_${Date.now()}@novaspark.io`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!Secure", displayName: "Filter User", mobileNumber: "+61412345678", countryCode: "+61", countryIso2: "AU", country: "Australia", agreeTerms: true }),
  })).json();
  const token = reg.session.access_token;
  const headers = { Authorization: "Bearer " + token };

  // unread_only filter
  const unreadRes = await fetch(`${BASE}/api/user/notifications?unread_only=true`, { headers });
  assert.equal(unreadRes.status, 200);
  const unreadData = await unreadRes.json();
  assert.ok(unreadData.notifications.every((n) => n.read === false));

  // type filter for a valid type
  const typeRes = await fetch(`${BASE}/api/user/notifications?type=transaction`, { headers });
  assert.equal(typeRes.status, 200);
  const typeData = await typeRes.json();
  assert.ok(typeData.notifications.every((n) => n.type === "transaction"));
});

// ─── Admin panel tests ───────────────────────────────────────────────────────

test("Live API: Unauthenticated access to admin routes is rejected", async () => {
  const paths = [
    "/api/admin/dashboard",
    "/api/admin/users",
    "/api/admin/kyc",
    "/api/admin/presale/rounds",
    "/api/admin/staking/config",
    "/api/admin/withdrawals",
    "/api/admin/support/tickets",
    "/api/admin/content/roadmap",
    "/api/admin/reports?type=users",
    "/api/admin/audit-log",
  ];
  for (const path of paths) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 401, `expected 401 for ${path}`);
  }
});

test("Live API: Non-admin authenticated user is rejected from admin routes (403)", async () => {
  const { token } = await registerUser("notadmin");
  const headers = { Authorization: "Bearer " + token };
  const res = await fetch(`${BASE}/api/admin/dashboard`, { headers });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.ok(data.error);
});

test("Live API & Supabase: Admin dashboard returns real stats shape", async () => {
  const { token } = await registerAndPromoteAdmin("admdash");
  const headers = { Authorization: "Bearer " + token };
  const res = await fetch(`${BASE}/api/admin/dashboard`, { headers });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.stats);
});

test("Live API & Supabase: Admin users list, detail, and status update lifecycle", async () => {
  const { token } = await registerAndPromoteAdmin("admusers");
  const { userId: targetId } = await registerUser("admtarget");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const listRes = await fetch(`${BASE}/api/admin/users?limit=5`, { headers });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.ok, true);
  assert.ok(Array.isArray(listData.users));
  assert.ok(typeof listData.total === "number");

  const detailRes = await fetch(`${BASE}/api/admin/users/${targetId}`, { headers });
  assert.equal(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.equal(detailData.ok, true);
  assert.equal(detailData.profile.id, targetId);

  // Too-short reason is rejected
  const badRes = await fetch(`${BASE}/api/admin/users/${targetId}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "suspended", reason: "short" }),
  });
  assert.equal(badRes.status, 400);

  // Valid reason succeeds
  const okRes = await fetch(`${BASE}/api/admin/users/${targetId}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "suspended", reason: "Violated terms of service repeatedly." }),
  });
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.equal(okData.ok, true);
  assert.equal(okData.profile.status, "suspended");
});

test("Live API & Supabase: Admin presale round create, update, and status lifecycle", async () => {
  const { token } = await registerAndPromoteAdmin("admpresale");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const start = new Date(Date.now() + 60_000).toISOString();
  const end = new Date(Date.now() + 86_400_000).toISOString();
  const createRes = await fetch(`${BASE}/api/admin/presale/rounds`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Test Round ${Date.now()}`,
      price_usd: 0.05,
      hard_cap: 100000,
      min_per_wallet: 10,
      max_per_wallet: 1000,
      start_time: start,
      end_time: end,
    }),
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.ok, true);
  const roundId = createData.round.id;

  const updateRes = await fetch(`${BASE}/api/admin/presale/rounds/${roundId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ price_usd: 0.07 }),
  });
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(Number(updateData.round.price_usd), 0.07);

  const statusRes = await fetch(`${BASE}/api/admin/presale/rounds/${roundId}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "paused" }),
  });
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.round.status, "paused");

  const listRes = await fetch(`${BASE}/api/admin/presale/rounds`, { headers });
  const listData = await listRes.json();
  assert.ok(listData.rounds.some((r) => r.id === roundId));
});

test("Live API & Supabase: Admin staking config create, update, and stats", async () => {
  const { token } = await registerAndPromoteAdmin("admstaking");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const lockDays = 1000 + Math.floor(Math.random() * 1000);
  const createRes = await fetch(`${BASE}/api/admin/staking/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ lock_days: lockDays, reward_rate_bps: 500 }),
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.ok, true);
  const configId = createData.config.id;

  const updateRes = await fetch(`${BASE}/api/admin/staking/config/${configId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ reward_rate_bps: 750 }),
  });
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(updateData.config.reward_rate_bps, 750);

  const statsRes = await fetch(`${BASE}/api/admin/staking/stats`, { headers });
  assert.equal(statsRes.status, 200);
  const statsData = await statsRes.json();
  assert.equal(statsData.ok, true);
  assert.ok(statsData.stats);
});

test("Live API & Supabase: Admin withdrawals list returns paginated shape", async () => {
  const { token } = await registerAndPromoteAdmin("admwithdraw");
  const headers = { Authorization: "Bearer " + token };
  const res = await fetch(`${BASE}/api/admin/withdrawals?page=1&limit=5`, { headers });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.withdrawals));
  assert.ok(typeof data.total === "number");
  assert.ok(typeof data.totalPages === "number");
});

test("Live API & Supabase: Admin support tickets list returns paginated shape", async () => {
  const { token } = await registerAndPromoteAdmin("admsupport");
  const headers = { Authorization: "Bearer " + token };
  const res = await fetch(`${BASE}/api/admin/support/tickets?page=1&limit=5`, { headers });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.tickets));
});

test("Live API & Supabase: Admin content (roadmap) create, update, delete round-trip", async () => {
  const { token } = await registerAndPromoteAdmin("admcontent");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const createRes = await fetch(`${BASE}/api/admin/content/roadmap`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: `Test Item ${Date.now()}`, status: "planned", category: "general" }),
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.ok, true);
  const itemId = createData.item.id;

  const listRes = await fetch(`${BASE}/api/admin/content/roadmap`, { headers });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.ok(listData.roadmap.some((r) => r.id === itemId));

  const updateRes = await fetch(`${BASE}/api/admin/content/roadmap/${itemId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "done" }),
  });
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(updateData.item.status, "done");

  const deleteRes = await fetch(`${BASE}/api/admin/content/roadmap/${itemId}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleteRes.status, 200);
  const deleteData = await deleteRes.json();
  assert.equal(deleteData.ok, true);
});

test("Live API & Supabase: Admin reports endpoint returns report for each type", async () => {
  const { token } = await registerAndPromoteAdmin("admreports");
  const headers = { Authorization: "Bearer " + token };

  for (const type of ["users", "transactions", "staking", "referrals"]) {
    const res = await fetch(`${BASE}/api/admin/reports?type=${type}`, { headers });
    assert.equal(res.status, 200, `expected 200 for report type ${type}`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.type, type);
    assert.ok(data.report);
  }
});

test("Live API & Supabase: Admin audit log records and lists admin actions", async () => {
  const { token, userId: adminId } = await registerAndPromoteAdmin("admaudit");
  const { userId: targetId } = await registerUser("admauditTarget");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  // Trigger an audited action
  await fetch(`${BASE}/api/admin/users/${targetId}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "suspended", reason: "Audit log verification test case." }),
  });

  const res = await fetch(`${BASE}/api/admin/audit-log?page=1&limit=20`, { headers });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.entries));
  assert.ok(data.entries.some((l) => l.admin_id === adminId));
});
