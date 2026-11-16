import { Router } from "express";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { applyCallback } from "../services/payments.js";

const router = Router();

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Daraja calls this endpoint. Callbacks carry no signature, so we require a secret token in the
// URL we registered, then match the CheckoutRequestID to a payment we created, then verify the
// amount and receipt before marking anything as paid.
// Both paths are accepted so either value of MPESA_CALLBACK_URL works:
//   .../api/payments/callback   or   .../api/payments/mpesa/callback
router.post(["/callback", "/mpesa/callback"], async (req, res) => {
  if (!env.MPESA_CALLBACK_TOKEN || !safeEqual(req.query.token, env.MPESA_CALLBACK_TOKEN)) {
    console.warn("M-Pesa callback rejected: missing or wrong token (check MPESA_CALLBACK_TOKEN and the registered URL)");
    return res.status(403).json({ ResultCode: 1, ResultDesc: "Forbidden" });
  }
  const cb = req.body?.Body?.stkCallback;
  console.log("M-Pesa callback received:", { checkout: cb?.CheckoutRequestID, ResultCode: cb?.ResultCode, ResultDesc: cb?.ResultDesc });
  try {
    const outcome = await applyCallback(req.body);
    console.log("M-Pesa callback:", outcome);
  } catch (e) {
    console.error("M-Pesa callback processing error:", e);
  }
  // Always acknowledge so Safaricom does not keep retrying; processing is idempotent.
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

export default router;