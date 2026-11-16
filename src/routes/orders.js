import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { asyncHandler, HttpError } from "../utils/httpError.js";
import { normalizeKenyanPhone, unwrap } from "../utils/helpers.js";
import { validate } from "../middleware/validate.js";
import { checkoutLimiter } from "../middleware/rateLimit.js";
import { startPayment, reconcilePayment, finalizeUnsuccessful } from "../services/payments.js";
import { sendNotification } from "../services/email.js";

const router = Router();

const orderSchema = z.object({
  customer_name: z.string().trim().min(2, "Enter your name").max(120),
  customer_email: z.string().trim().email("Enter a valid email").max(200),
  customer_phone: z.string().trim().min(9, "Enter your M-Pesa number").max(20),
  instructions: z.string().trim().max(2000).optional().default(""),
  items: z
    .array(z.object({ service_id: z.string().uuid(), quantity: z.number().int().min(1).max(100) }))
    .min(1, "Your cart is empty")
    .max(20),
  website: z.string().optional().default(""), // honeypot
});

// Create order (prices are ALWAYS read from the database, never trusted from the browser)
router.post(
  "/",
  checkoutLimiter,
  validate(orderSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.website) throw new HttpError(400, "Request rejected");

    const phone = normalizeKenyanPhone(b.customer_phone);
    if (!phone) throw new HttpError(400, "Enter a valid Safaricom number, e.g. 0712 345 678");

    // merge duplicate service lines
    const wanted = new Map();
    for (const i of b.items) wanted.set(i.service_id, (wanted.get(i.service_id) ?? 0) + i.quantity);

    const services = unwrap(
      await supabase
        .from("services")
        .select("id,title,price_kes,allow_quantity")
        .in("id", [...wanted.keys()])
        .eq("is_active", true)
    );
    if (services.length !== wanted.size) {
      throw new HttpError(400, "One or more services are no longer available. Please refresh your cart.");
    }

    let total = 0;
    const lines = services.map((s) => {
      const quantity = s.allow_quantity ? Math.min(wanted.get(s.id), 100) : 1;
      total += Number(s.price_kes) * quantity;
      return { service_id: s.id, service_title: s.title, unit_price_kes: s.price_kes, quantity };
    });
    if (total < 1) throw new HttpError(400, "Order total must be at least KES 1");

    const order = unwrap(
      await supabase
        .from("orders")
        .insert({
          customer_name: b.customer_name,
          customer_email: b.customer_email,
          customer_phone: phone,
          instructions: b.instructions || null,
          total_kes: total,
        })
        .select()
        .single()
    );
    unwrap(await supabase.from("order_items").insert(lines.map((l) => ({ ...l, order_id: order.id }))));

    sendNotification(`New order ${order.reference}`, `${b.customer_name} ordered KES ${total}.`);

    // Start M-Pesa in the BACKGROUND: Safaricom can take 10+ seconds to answer, and the customer should not
    // be left staring at a spinner. The order page polls for the result and shows any failure reason
    // (startPayment records failures on the payment and order itself). The customer can retry from there.
    startPayment(order, phone).catch((e) => console.error(`Payment start failed for ${order.reference}:`, e.message));
    res.status(201).json({
      reference: order.reference,
      payment_status: "pending",
      message: "Order created. Sending the M-Pesa request to your phone…",
    });
  })
);

async function loadOrder(reference) {
  return unwrap(
    await supabase
      .from("orders")
      .select("id,reference,customer_name,customer_phone,total_kes,payment_status,fulfilment_status,created_at,order_items(service_title,unit_price_kes,quantity,line_total_kes)")
      .eq("reference", reference)
      .maybeSingle(),
    "Order not found"
  );
}

async function latestPayment(orderId) {
  const { data } = await supabase
    .from("payments")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

const maskPhone = (p) => (p ? `${p.slice(0, 5)}***${p.slice(-3)}` : null);

// Public status lookup by order reference. Returns no email and a masked phone number.
router.get(
  "/:reference/status",
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req.params.reference);
    let payment = await latestPayment(order.id);
    payment = await reconcilePayment(payment);
    const paymentStatus = payment?.status ?? order.payment_status;

    res.json({
      reference: order.reference,
      customer_name: order.customer_name,
      phone: maskPhone(order.customer_phone),
      total_kes: order.total_kes,
      payment_status: paymentStatus,
      fulfilment_status: order.fulfilment_status,
      mpesa_receipt: paymentStatus === "paid" ? payment?.mpesa_receipt_number ?? null : null,
      failure_reason: ["failed", "cancelled"].includes(paymentStatus) ? payment?.result_desc ?? null : null,
      items: order.order_items,
      created_at: order.created_at,
    });
  })
);

// Customer cancels an open payment from the waiting page.
router.post(
  "/:reference/cancel",
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req.params.reference);
    const payment = await latestPayment(order.id);
    if (!payment || !["pending", "processing"].includes(payment.status)) {
      return res.json({ payment_status: payment?.status ?? order.payment_status });
    }
    await finalizeUnsuccessful(payment, "cancelled", null, "Cancelled by customer");
    res.json({ payment_status: "cancelled" });
  })
);

// Retry payment for an unpaid order
router.post(
  "/:reference/pay",
  checkoutLimiter,
  validate(z.object({ phone: z.string().trim().max(20).optional() })),
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req.params.reference);
    const current = await latestPayment(order.id);

    if (order.payment_status === "paid" || current?.status === "paid") throw new HttpError(409, "This order is already paid.");
    if (current?.status === "processing" && Date.now() - new Date(current.created_at).getTime() < 2 * 60_000) {
      throw new HttpError(409, "A payment prompt is already active. Check your phone.");
    }
    // If a previous prompt is still open, close it so it cannot be confused with the new one.
    if (current && ["pending", "processing"].includes(current.status)) {
      await supabase.from("payments").update({ status: "failed", result_desc: "Superseded by a new attempt" }).eq("id", current.id).in("status", ["pending", "processing"]);
    }

    const phone = normalizeKenyanPhone(req.body.phone || order.customer_phone);
    if (!phone) throw new HttpError(400, "Enter a valid Safaricom number, e.g. 0712 345 678");

    const { data: full } = await supabase.from("orders").select("*").eq("id", order.id).single();
    await startPayment(full, phone);
    res.json({ payment_status: "processing", message: "Check your phone and enter your M-Pesa PIN." });
  })
);

export default router;