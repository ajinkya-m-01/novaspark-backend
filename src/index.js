import express from "express";
import cors from "cors";
import { config } from "./config.js";
import contentRoutes from "./routes/content.js";
import formRoutes from "./routes/forms.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";

const app = express();

app.disable("x-powered-by");

app.use(
  cors({
    origin: config.corsOrigin,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api", contentRoutes);
app.use("/api", formRoutes);

// 404 JSON handler for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err, req, res, next) => {
  if (
    err instanceof SyntaxError &&
    (err.status === 400 || err.type === "entity.parse.failed") &&
    "body" in err
  ) {
    return res.status(400).json({ error: "Malformed JSON" });
  }
  console.error("Server error:", err);
  return res.status(500).json({ error: "Server error" });
});

app.listen(config.port, () => {
  console.log(`Backend running at http://localhost:${config.port}`);
});

export default app;
