import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().min(1, "SUPABASE_URL is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET is required (min 16 chars)"),
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  EMAIL_FROM: z.string().min(1, "EMAIL_FROM is required"),
  FRONTEND_URL: z.string().min(1, "FRONTEND_URL is required"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  ADMIN_EMAIL: z.string().email().or(z.literal("")).default(""),
  SUPABASE_STORAGE_BUCKET_KYC: z.string().default("kyc-documents"),
  SUPABASE_STORAGE_BUCKET_SUPPORT: z.string().default("support-attachments"),
  BRAND_NAME: z.string().default("Platform"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error("❌ Missing or invalid environment variables:\n" + missing);
  process.exit(1);
}

export const config = { ...parsed.data, SUPABASE_STORAGE_URL: parsed.data.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1" };
export default config;
