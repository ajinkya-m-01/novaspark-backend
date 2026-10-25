import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import contentRoutes from "./routes/content.js";
import formRoutes from "./routes/forms.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import adminRoutes from "./routes/admin.js";
import dashboardRouter from "./routes/dashboard.js";
import transactionsRouter from "./routes/transactions.js";
import stakingRouter from "./routes/staking.js";
import rewardsRouter from "./routes/rewards.js";
import announcementsRouter from "./routes/announcements.js";
import { requireAuth } from "./middleware/auth.js";

import kycRouter from "./routes/kyc.js";
import supportRouter from "./routes/support.js";
import withdrawalsRouter from "./routes/withdrawals.js";
import membershipRouter from "./routes/membership.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = [
  config.CORS_ORIGIN,
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.startsWith("http://localhost:")) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/user/dashboard", requireAuth, dashboardRouter);
app.use("/api/user/transactions", requireAuth, transactionsRouter);
app.use("/api/user/staking", requireAuth, stakingRouter);
app.use("/api/user/rewards", requireAuth, rewardsRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/user/kyc", requireAuth, kycRouter);
app.use("/api/user/support", requireAuth, supportRouter);
app.use("/api/user/withdrawals", requireAuth, withdrawalsRouter);
app.use("/api/user/membership", requireAuth, membershipRouter);
app.use("/api/user", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", contentRoutes);
app.use("/api", formRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler — no stack traces in production
app.use((err, _req, res, _next) => {
  if (
    err instanceof SyntaxError &&
    (err.status === 400 || err.type === "entity.parse.failed") &&
    "body" in err
  ) {
    return res.status(400).json({ error: "Malformed JSON" });
  }
  if (err.name === "MulterError") return res.status(400).json({ error: "Invalid upload: " + err.message });
  if (err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message, ...(err.fields ? {fields:err.fields} : {}) });
  console.error("Server error:", err.message);
  return res.status(500).json({ error: "Server error" });
});


export default app;
