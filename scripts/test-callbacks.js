// Developer tool: exercises the callback endpoint with success / failed / cancelled / duplicate
// payloads for an order you created in SANDBOX. It does NOT create payments: it only replays
// Daraja-shaped callbacks to test how the backend handles them.
//
// Usage (server running):
//   node scripts/test-callbacks.js <CheckoutRequestID> <amount> [baseUrl]
// Find the CheckoutRequestID in the `payments` table after starting a checkout.
import "dotenv/config";

const [checkoutId, amountArg, baseUrl = `http://localhost:${process.env.PORT || 5000}`] = process.argv.slice(2);
if (!checkoutId || !amountArg) {
  console.error("Usage: node scripts/test-callbacks.js <CheckoutRequestID> <amount> [baseUrl]");
  process.exit(1);
}
const url = `${baseUrl}/api/payments/mpesa/callback?token=${encodeURIComponent(process.env.MPESA_CALLBACK_TOKEN || "")}`;

const body = (code, desc, extra = {}) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: "test-merchant",
      CheckoutRequestID: checkoutId,
      ResultCode: code,
      ResultDesc: desc,
      ...extra,
    },
  },
});

const success = (receipt, amount) =>
  body(0, "The service request is processed successfully.", {
    CallbackMetadata: {
      Item: [
        { Name: "Amount", Value: amount },
        { Name: "MpesaReceiptNumber", Value: receipt },
        { Name: "PhoneNumber", Value: 254700000000 },
      ],
    },
  });

async function post(label, payload, target = url) {
  const res = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  console.log(`${label.padEnd(34)} -> HTTP ${res.status}`);
}

const scenario = process.env.SCENARIO || "all";
const amount = Number(amountArg);

(async () => {
  await post("forged callback (bad token)", success("FAKE123", amount), url.replace(/token=[^&]*/, "token=wrong"));
  // "wrongamount" finalises the payment as failed, so it must NOT be part of "all" (a later success would be ignored).
  if (scenario === "wrongamount") await post("wrong amount (expect failed)", success("TESTRCPT0", amount + 1));
  if (scenario === "all" || scenario === "success") {
    await post("successful payment", success("TEST" + Date.now().toString(36).toUpperCase(), amount));
    await post("duplicate of success (ignored)", success("TESTDUP", amount));
  }
  if (scenario === "cancelled") await post("cancelled by user (1032)", body(1032, "Request cancelled by user"));
  if (scenario === "failed") await post("failed (1)", body(1, "The balance is insufficient for the transaction"));
  console.log("\nCheck the order status page and the payments table. Use SCENARIO=cancelled|failed|success|wrongamount to run one case on a fresh payment.");
})();