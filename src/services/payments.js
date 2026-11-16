import { supabase } from "../config/supabase.js";
import { stkPush, stkQuery } from "./mpesa.js";
import { sendNotification } from "./email.js";

const OPEN = ["pending", "processing"];
const lastQueryAt = new Map(); // payment id -> time of last Safaricom status query

const setOrderPaymentStatus = (orderId, status) =>
  supabase.from("orders").update({ payment_status: status }).eq("id", orderId);

// Create a payment row, then ask Safaricom to prompt the customer.
export async function startPayment(order, phone) {
  const amount = Math.ceil(Number(order.total_kes)); // M-Pesa accepts whole shillings only

  const { data: payment, error } = await supabase
    .from("payments")
    .insert({ order_id: order.id, amount_kes: amount, phone, status: "pending" })
    .select()
    .single();
  if (error) throw error;

  try {
    const { merchantRequestId, checkoutRequestId } = await stkPush({
      phone,
      amount,
      reference: order.reference,
    });
    await supabase
      .from("payments")
      .update({
        status: "processing",
        merchant_request_id: merchantRequestId,
        checkout_request_id: checkoutRequestId,
      })
      .eq("id", payment.id);
    await setOrderPaymentStatus(order.id, "processing");
    return { status: "processing" };
  } catch (e) {
    await supabase
      .from("payments")
      .update({ status: "failed", result_desc: String(e.message).slice(0, 300) })
      .eq("id", payment.id);
    await setOrderPaymentStatus(order.id, "failed");
    throw e;
  }
}

// Move an OPEN payment to a final failed/cancelled state. Conditional update = idempotent.
export async function finalizeUnsuccessful(payment, status, resultCode, resultDesc, payload = null) {
  const { data } = await supabase
    .from("payments")
    .update({
      status,
      result_code: resultCode,
      result_desc: resultDesc,
      callback_payload: payload,
      callback_received_at: payload ? new Date().toISOString() : null,
    })
    .eq("id", payment.id)
    .in("status", OPEN)
    .select("id");
  if (data?.length) await setOrderPaymentStatus(payment.order_id, status);
  return Boolean(data?.length);
}

// Process the Daraja callback body. Returns a short outcome string (for logs/tests).
export async function applyCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return "ignored:malformed";

  const { data: payment, error } = await supabase
    .from("payments")
    .select("*")
    .eq("checkout_request_id", cb.CheckoutRequestID)
    .maybeSingle();
  if (error) throw error;
  if (!payment) return "ignored:unknown-checkout-request";

  const code = Number(cb.ResultCode);

  // Already confirmed through the status query: a late successful callback only adds the receipt.
  if (payment.status === "paid" && !payment.mpesa_receipt_number && code === 0) {
    const items0 = cb.CallbackMetadata?.Item ?? [];
    const rec = items0.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
    if (rec) {
      const { error: e2 } = await supabase
        .from("payments")
        .update({ mpesa_receipt_number: String(rec), callback_payload: body, callback_received_at: new Date().toISOString() })
        .eq("id", payment.id)
        .is("mpesa_receipt_number", null);
      if (!e2) return "paid:receipt-backfilled";
    }
  }

  if (payment.status === "cancelled" && code === 0) {
    console.warn("M-Pesa money received for a CANCELLED payment, needs manual refund/review:", cb.CheckoutRequestID);
  }
  // Duplicate / late callback for an already-final payment: do nothing.
  if (!OPEN.includes(payment.status)) return `ignored:duplicate(${payment.status})`;

  if (code !== 0) {
    const status = code === 1032 ? "cancelled" : "failed"; // 1032 = cancelled by user
    await finalizeUnsuccessful(payment, status, code, cb.ResultDesc ?? null, body);
    return status;
  }

  const items = cb.CallbackMetadata?.Item ?? [];
  const meta = Object.fromEntries(items.map((i) => [i.Name, i.Value]));
  const receipt = meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null;
  const paidAmount = Number(meta.Amount);

  // Verify before marking paid: receipt present and amount matches what we asked for.
  if (!receipt || paidAmount !== Number(payment.amount_kes)) {
    await finalizeUnsuccessful(payment, "failed", code, "Verification failed (missing receipt or amount mismatch): needs manual review", body);
    console.error("M-Pesa verification failed", { checkout: cb.CheckoutRequestID, receipt, paidAmount, expected: payment.amount_kes });
    return "failed:verification";
  }

  const { data: updated, error: updErr } = await supabase
    .from("payments")
    .update({
      status: "paid",
      mpesa_receipt_number: receipt,
      result_code: 0,
      result_desc: cb.ResultDesc ?? null,
      callback_payload: body,
      callback_received_at: new Date().toISOString(),
    })
    .eq("id", payment.id)
    .in("status", OPEN)
    .select("id");

  if (updErr) {
    if (updErr.code === "23505") return "ignored:duplicate-receipt"; // unique receipt guard
    throw updErr;
  }
  if (!updated?.length) return "ignored:duplicate(race)";

  await setOrderPaymentStatus(payment.order_id, "paid");
  sendNotification("New paid order", `Payment ${receipt} received for KES ${payment.amount_kes}.`);
  return "paid";
}

// Asks Safaricom what happened to a prompt. The STK Query response is Safaricom's authenticated
// answer to OUR request (unlike an inbound callback, which anyone could post), so ResultCode 0
// is trusted as "paid" even if the callback never reaches this server. The receipt number is
// backfilled if the callback arrives later.
let queryInFlight = false;
let queryPausedUntil = 0; // global cooldown after Safaricom says 429 // only one Safaricom status query at a time (their limit is tight)
function queryInBackground(payment) {
  if (queryInFlight || Date.now() < queryPausedUntil) return;
  queryInFlight = true;
  stkQuery(payment.checkout_request_id)
    .then(async (q) => {
      const code = Number(q.ResultCode);
      console.log("STK query result:", { checkout: payment.checkout_request_id, ResultCode: q.ResultCode, ResultDesc: q.ResultDesc });
      if (Number.isNaN(code)) return;
      if (code !== 0) {
        return finalizeUnsuccessful(payment, code === 1032 ? "cancelled" : "failed", code, q.ResultDesc ?? null);
      }
      const { data } = await supabase
        .from("payments")
        .update({ status: "paid", result_code: 0, result_desc: q.ResultDesc ?? "Confirmed by STK query", callback_received_at: new Date().toISOString() })
        .eq("id", payment.id)
        .in("status", OPEN)
        .select("id");
      if (data?.length) {
        await setOrderPaymentStatus(payment.order_id, "paid");
        sendNotification("New paid order", `Payment confirmed by status query for KES ${payment.amount_kes}.`);
        console.log("Payment confirmed via STK query:", payment.checkout_request_id);
      }
    })
    .catch((e) => {
      // 500 = still processing; 429/timeout = rate limited or slow, so wait longer before asking again.
      const status = e.response?.status;
      if (status === 429) queryPausedUntil = Date.now() + 60_000; // whole app is throttled: stop asking for a minute
      if (status === 429 || !status) lastQueryAt.set(payment.id, Date.now() + 30_000);
      console.log("STK query not ready:", status || e.message);
    })
    .finally(() => {
      queryInFlight = false;
    });
}

// Called when the customer's browser polls the order. Detects failed prompts and timeouts.
export async function reconcilePayment(payment) {
  if (!payment || !OPEN.includes(payment.status)) return payment;
  const age = Date.now() - new Date(payment.created_at).getTime();

  // A payment still "pending" after 2 minutes means the request to Safaricom never completed
  // (e.g. the server restarted mid-way). Close it so the customer can retry.
  if (payment.status === "pending" && age > 2 * 60_000) {
    await finalizeUnsuccessful(payment, "failed", null, "The M-Pesa request could not be sent. Please try again.");
    const { data } = await supabase.from("payments").select("*").eq("id", payment.id).single();
    return data;
  }
  if (payment.status !== "processing" || age < 12_000) return payment;

  // Safaricom rate-limits status queries ("spike arrest") and the sandbox can be slow, so:
  //  - ask at most once per 15 seconds per payment, and
  //  - do it in the BACKGROUND (not awaited) so the customer's status check returns immediately.
  const last = lastQueryAt.get(payment.id) ?? 0;
  if (payment.checkout_request_id && Date.now() - last >= 15_000) {
    lastQueryAt.set(payment.id, Date.now());
    queryInBackground(payment);
  }

  if (age > 5 * 60_000) {
    await finalizeUnsuccessful(payment, "failed", null, "Timed out waiting for M-Pesa confirmation");
  }
  const { data } = await supabase.from("payments").select("*").eq("id", payment.id).single();
  return data;
}