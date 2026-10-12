import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Dedicated service-role client for backend database operations (bypasses RLS)
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// Auth client factory to prevent user credentials from mutating the service-role client
export const createAuthClient = () =>
  createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

export default supabase;
