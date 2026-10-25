import { supabase } from "../supabase.js";

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("status, is_admin, role, unique_user_id, country_iso2")
      .eq("id", data.user.id)
      .maybeSingle();

    if (profile && profile.status !== "active") {
      return res.status(403).json({
        error: `Account ${profile.status}`,
        status: profile.status,
      });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
      status: profile?.status ?? "active",
      is_admin: profile?.is_admin ?? false,
      role: profile?.role ?? "user",
      unique_user_id: profile?.unique_user_id ?? null,
      country_iso2: profile?.country_iso2 ?? null,
    };
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ error: "Authentication failed" });
  }
}

export async function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!req.user.is_admin && req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];
  try {
    const { data } = await supabase.auth.getUser(token);
    if (data?.user) {
      req.user = data.user;
    }
  } catch {
    // optional auth continues even if token fails
  }
  next();
}
