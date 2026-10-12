import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { contactSchema, subscribeSchema } from "../src/validators.js";

test("Validators: contactSchema accepts valid input", () => {
  const valid = {
    name: "Alex Doe",
    email: "alex@example.com",
    message: "Interested in partnership and integration with NovaSpark.",
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
  const res = await fetch("http://localhost:4000/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test("Live API: GET /api/roadmap returns roadmap array", async () => {
  const res = await fetch("http://localhost:4000/api/roadmap");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length > 0);
});

test("Live API: GET /api/team returns team array", async () => {
  const res = await fetch("http://localhost:4000/api/team");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length > 0);
});

test("Live API: POST /api/auth/nonce generates valid challenge for 0x address", async () => {
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  const res = await fetch("http://localhost:4000/api/auth/nonce", {
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
  const nonceRes = await fetch("http://localhost:4000/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();

  // 2. Sign message with private key
  const signature = await account.signMessage({ message: nonceData.message });

  // 3. Verify on backend
  const verifyRes = await fetch("http://localhost:4000/api/auth/verify-wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature: signature,
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
  const nonceRes = await fetch("http://localhost:4000/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();

  // 2. Sign with a DIFFERENT account
  const diffAccount = privateKeyToAccount(generatePrivateKey());
  const badSignature = await diffAccount.signMessage({ message: nonceData.message });

  // 3. Send mismatching address and signature
  const verifyRes = await fetch("http://localhost:4000/api/auth/verify-wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature: badSignature,
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
  const regRes = await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  assert.equal(regData.ok, true);
  assert.ok(regData.user.id);
  assert.ok(regData.session?.access_token);

  const token = regData.session.access_token;

  // 2. Login
  const loginRes = await fetch("http://localhost:4000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.equal(loginData.ok, true);
  assert.equal(loginData.profile?.email, email);

  // 3. GET /me
  const meRes = await fetch("http://localhost:4000/api/auth/me", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.ok, true);
  assert.equal(meData.profile.display_name, displayName);

  // 4. Update profile name
  const patchRes = await fetch("http://localhost:4000/api/user/profile", {
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

  const nonceRes = await fetch("http://localhost:4000/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();
  const signature = await account.signMessage({ message: nonceData.message });

  const verifyRes = await fetch("http://localhost:4000/api/auth/verify-wallet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      address: account.address,
      signature: signature,
    }),
  });
  assert.equal(verifyRes.status, 200);

  // 6. Check wallets list
  const walletsRes = await fetch("http://localhost:4000/api/user/wallets", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(walletsRes.status, 200);
  const walletsData = await walletsRes.json();
  assert.ok(walletsData.wallets.some((w) => w.address.toLowerCase() === account.address.toLowerCase()));

  // 7. Check notifications list
  const notifsRes = await fetch("http://localhost:4000/api/user/notifications", {
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
  const nonceRes = await fetch("http://localhost:4000/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const nonceData = await nonceRes.json();

  // 2. Sign challenge
  const signature = await account.signMessage({ message: nonceData.message });

  // 3. Verify WITHOUT Bearer token
  const verifyRes = await fetch("http://localhost:4000/api/auth/verify-wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      signature: signature,
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
  const regARes = await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailA, password, displayName: "Referrer Alpha" }),
  });
  assert.equal(regARes.status, 201);
  const regAData = await regARes.json();
  const codeA = regAData.user.referralCode;
  const tokenA = regAData.session.access_token;
  assert.ok(codeA.startsWith("NSP-"));

  // 2. Register User B using User A's referral code
  const regBRes = await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: emailB,
      password,
      displayName: "Referee Beta",
      referralCode: codeA,
    }),
  });
  assert.equal(regBRes.status, 201);
  const regBData = await regBRes.json();
  assert.equal(regBData.user.referredBy, codeA);

  // 3. Verify User A's referral dashboard
  const refRes = await fetch("http://localhost:4000/api/user/referrals", {
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
  const regCRes = await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: emailC,
      password,
      displayName: "Normal User",
      referralCode: "NSP-NONEXISTENT999",
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
  const regA = await (await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailA, password, displayName: "User Alpha" }),
  })).json();
  const tokenA = regA.session.access_token;

  // Register User B
  const regB = await (await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emailB, password, displayName: "User Beta" }),
  })).json();
  const tokenB = regB.session.access_token;

  // Generate a dedicated test wallet
  const privKey = generatePrivateKey();
  const account = privateKeyToAccount(privKey);

  // User A links the wallet
  const nonceResA = await (await fetch("http://localhost:4000/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json();
  const sigA = await account.signMessage({ message: nonceResA.message });

  const linkResA = await fetch("http://localhost:4000/api/auth/verify-wallet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tokenA,
    },
    body: JSON.stringify({ address: account.address, signature: sigA }),
  });
  assert.equal(linkResA.status, 200);

  // User B tries to link the SAME wallet -> Must return 409 Conflict
  const nonceResB = await (await fetch("http://localhost:4000/api/auth/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json();
  const sigB = await account.signMessage({ message: nonceResB.message });

  const linkResB = await fetch("http://localhost:4000/api/auth/verify-wallet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tokenB,
    },
    body: JSON.stringify({ address: account.address, signature: sigB }),
  });
  assert.equal(linkResB.status, 409);
  const conflictData = await linkResB.json();
  assert.ok(conflictData.error.includes("already linked to another NovaSpark account"));

  // User A unlinks the wallet
  const walletsResA = await (await fetch("http://localhost:4000/api/user/wallets", {
    headers: { Authorization: "Bearer " + tokenA },
  })).json();
  const walletRecord = walletsResA.wallets.find((w) => w.address.toLowerCase() === account.address.toLowerCase());
  assert.ok(walletRecord);

  const unlinkRes = await fetch(`http://localhost:4000/api/user/wallets/${walletRecord.id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + tokenA },
  });
  assert.equal(unlinkRes.status, 200);

  // Verify wallet is removed from User A
  const afterWalletsA = await (await fetch("http://localhost:4000/api/user/wallets", {
    headers: { Authorization: "Bearer " + tokenA },
  })).json();
  assert.ok(!afterWalletsA.wallets.some((w) => w.id === walletRecord.id));
});

test("Live API & Supabase: Notification Read Action & Persistence", async () => {
  const timestamp = Date.now();
  const email = `notif_user_${timestamp}@novaspark.io`;
  const password = "Password123!Secure";

  const reg = await (await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })).json();
  const token = reg.session.access_token;

  // Fetch notifications
  const notifsRes = await fetch("http://localhost:4000/api/user/notifications", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(notifsRes.status, 200);
  const notifsData = await notifsRes.json();
  assert.ok(notifsData.notifications.length >= 1);
  const notif = notifsData.notifications[0];
  assert.equal(notif.read, false);

  // Mark as read
  const markRes = await fetch(`http://localhost:4000/api/user/notifications/${notif.id}/read`, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(markRes.status, 200);

  // Verify persistence on fresh fetch
  const refetchedRes = await fetch("http://localhost:4000/api/user/notifications", {
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
  const reg = await (await fetch("http://localhost:4000/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: oldPassword }),
  })).json();
  const token = reg.session.access_token;

  // Forgot password request: accepts 200 (if SMTP quota available) or 429 (if Supabase free SMTP rate-limit reached)
  const forgotRes = await fetch("http://localhost:4000/api/auth/forgot-password", {
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
  const resetRes = await fetch("http://localhost:4000/api/auth/reset-password", {
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
  const newLoginRes = await fetch("http://localhost:4000/api/auth/login", {
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
    { url: "http://localhost:4000/api/auth/me", method: "GET" },
    { url: "http://localhost:4000/api/user/profile", method: "GET" },
    { url: "http://localhost:4000/api/user/wallets", method: "GET" },
    { url: "http://localhost:4000/api/user/notifications", method: "GET" },
    { url: "http://localhost:4000/api/user/referrals", method: "GET" },
    { url: "http://localhost:4000/api/auth/reset-password", method: "POST" },
  ];

  for (const ep of unauthEndpoints) {
    const res = await fetch(ep.url, { method: ep.method });
    assert.equal(res.status, 401, `Endpoint ${ep.url} should reject unauthenticated request`);
  }
});

test("Live API & Supabase: Contact Form Validation & Submission", async () => {
  const timestamp = Date.now();

  // Valid submission
  const validRes = await fetch("http://localhost:4000/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E Tester",
      email: `contact_${timestamp}@example.com`,
      message: "Testing NovaSpark platform contact form persistence and validation.",
    }),
  });
  assert.equal(validRes.status, 201);
  const validData = await validRes.json();
  assert.equal(validData.ok, true);

  // Invalid submission: message too short
  const shortRes = await fetch("http://localhost:4000/api/contact", {
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
  const sub1 = await fetch("http://localhost:4000/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: subEmail }),
  });
  assert.equal(sub1.status, 201);
  const data1 = await sub1.json();
  assert.equal(data1.ok, true);

  // Duplicate subscription handled cleanly
  const sub2 = await fetch("http://localhost:4000/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: subEmail }),
  });
  assert.equal(sub2.status, 409);
  const data2 = await sub2.json();
  assert.equal(data2.error, "Already subscribed");
});
