import { Router } from "express";
import { supabase } from "../supabase.js";

const router = Router();

router.get("/roadmap", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("roadmap")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("Error loading roadmap from Supabase:", error);
      return res.status(500).json({ error: "Could not load content" });
    }

    return res.json(data);
  } catch (err) {
    console.error("Unexpected error in /api/roadmap:", err);
    return res.status(500).json({ error: "Could not load content" });
  }
});

router.get("/team", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("team")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("Error loading team from Supabase:", error);
      return res.status(500).json({ error: "Could not load content" });
    }

    return res.json(data);
  } catch (err) {
    console.error("Unexpected error in /api/team:", err);
    return res.status(500).json({ error: "Could not load content" });
  }
});

export default router;
