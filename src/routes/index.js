import { Router } from "express";
import { supabase } from "../config/supabase.js";
import { asyncHandler } from "../utils/httpError.js";
import publicRoutes from "./public.js";
import contactRoutes from "./contact.js";
import orderRoutes from "./orders.js";
import paymentRoutes from "./payments.js";
import adminRoutes from "./admin.js";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Confirms the database connection and that the migrations were applied.
router.get(
  "/health/db",
  asyncHandler(async (req, res) => {
    const { error } = await supabase.from("website_settings").select("key").limit(1);
    if (error) return res.status(503).json({ status: "error", message: error.message });
    res.json({ status: "ok", database: "connected" });
  })
);

router.use("/public", publicRoutes);
router.use("/contact", contactRoutes);
router.use("/orders", orderRoutes);
router.use("/payments", paymentRoutes);
router.use("/admin", adminRoutes);

export default router;
