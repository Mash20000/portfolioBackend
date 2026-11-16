import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { asyncHandler } from "../utils/httpError.js";
import { unwrap, hashIp, normalizeKenyanPhone } from "../utils/helpers.js";
import { validate } from "../middleware/validate.js";
import { formLimiter } from "../middleware/rateLimit.js";
import { sendNotification } from "../services/email.js";

const router = Router();

const schema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(120),
  email: z.string().trim().email("Enter a valid email").max(200),
  phone: z.string().trim().max(20).optional().default(""),
  service_interest: z.string().trim().max(160).optional().default(""),
  budget_range: z.string().trim().max(60).optional().default(""),
  message: z.string().trim().min(10, "Please describe your request (10+ characters)").max(5000),
  website: z.string().optional().default(""), // honeypot: real users never fill this
  started_at: z.number().optional(), // client-side form-open timestamp (ms)
});

router.post(
  "/",
  formLimiter,
  validate(schema),
  asyncHandler(async (req, res) => {
    const b = req.body;

    // Spam traps: filled honeypot, or form submitted in under 2 seconds. Pretend success.
    const tooFast = b.started_at && Date.now() - b.started_at < 2000;
    if (b.website || tooFast) return res.status(201).json({ ok: true });

    let phone = null;
    if (b.phone) {
      phone = normalizeKenyanPhone(b.phone) || b.phone; // keep international numbers as typed
    }

    unwrap(
      await supabase.from("inquiries").insert({
        name: b.name,
        email: b.email,
        phone,
        service_interest: b.service_interest || null,
        budget_range: b.budget_range || null,
        message: b.message,
        ip_hash: hashIp(req.ip),
      })
    );

    sendNotification(
      `New inquiry from ${b.name}`,
      `${b.name} <${b.email}>\nService: ${b.service_interest}\nBudget: ${b.budget_range}\n\n${b.message}`
    );
    res.status(201).json({ ok: true });
  })
);

export default router;
