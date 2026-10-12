import "dotenv/config";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "Missing required environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY"
  );
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  supabaseUrl,
  supabaseServiceKey,
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
};

export default config;
