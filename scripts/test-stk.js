// Developer tool: sends ONE real STK Push using your server/.env and prints exactly what Safaricom replies.
// Use it to find out why a prompt does not arrive, without going through the website.
//
//   node scripts/test-stk.js 0712345678 1
//                            ^ phone      ^ amount in KES (default 1)
//
// It then waits ~25 seconds and asks Safaricom what happened to the prompt.
import "dotenv/config";
import { env } from "../src/config/env.js";
import { stkPush, stkQuery } from "../src/services/mpesa.js";
import { normalizeKenyanPhone } from "../src/utils/helpers.js";

const [phoneArg, amountArg = "1"] = process.argv.slice(2);
const phone = normalizeKenyanPhone(phoneArg);
if (!phone) {
  console.error("Usage: node scripts/test-stk.js <Safaricom number, e.g. 0712345678> [amount]");
  process.exit(1);
}

const mask = (v) => (v ? `${String(v).slice(0, 4)}…(${String(v).length} chars)` : "MISSING");
console.log("\n--- Configuration (secrets masked) ---");
console.log("environment      :", env.MPESA_ENVIRONMENT);
console.log("consumer key     :", mask(env.MPESA_CONSUMER_KEY));
console.log("consumer secret  :", mask(env.MPESA_CONSUMER_SECRET));
console.log("shortcode        :", env.MPESA_SHORTCODE);
console.log("passkey          :", mask(env.MPESA_PASSKEY));
console.log("callback url     :", (env.MPESA_CALLBACK_URL || "MISSING").replace(/token=[^&]*/, "token=***"));
console.log("callback token   :", mask(env.MPESA_CALLBACK_TOKEN));
if (env.MPESA_CALLBACK_URL && !env.MPESA_CALLBACK_URL.startsWith("https://")) {
  console.log("WARNING: the callback URL should start with https://");
}

console.log(`\n--- Sending STK Push: KES ${amountArg} to ${phone} ---`);
try {
  const { checkoutRequestId } = await stkPush({ phone, amount: Math.ceil(Number(amountArg)), reference: "TEST" + Date.now().toString().slice(-6) });
  console.log("ACCEPTED by Safaricom. CheckoutRequestID:", checkoutRequestId);
  console.log("Check the phone now. Waiting 25 seconds, then asking Safaricom for the result...");
  await new Promise((r) => setTimeout(r, 25000));
  try {
    const q = await stkQuery(checkoutRequestId);
    console.log("\n--- Status query ---");
    console.log(q);
    console.log("\nResultCode 0 = paid | 1032 = cancelled on phone | 1037 = phone unreachable/timeout | 1 = insufficient funds | 2001 = wrong PIN");
  } catch (e) {
    console.log("Status query failed (normal while the prompt is still open):", e.response?.data || e.message);
  }
} catch (e) {
  console.error("\nFAILED:", e.message);
  console.error("Safaricom's raw error (if any) was printed above as 'STK push failed'.");
  process.exit(1);
}