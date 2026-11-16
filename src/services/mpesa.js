import axios from "axios";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

const BASE =
  env.MPESA_ENVIRONMENT === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

let cachedToken = null;

function assertConfigured() {
  const missing = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_PASSKEY", "MPESA_SHORTCODE", "MPESA_CALLBACK_URL", "MPESA_CALLBACK_TOKEN"].filter(
    (k) => !env[k] || String(env[k]).startsWith("your-") || String(env[k]).includes("YOUR-")
  );
  if (missing.length) {
    console.error("M-Pesa not configured, missing/placeholder:", missing.join(", "));
    throw new HttpError(503, "Payments are not configured yet. Please contact the site owner.");
  }
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const auth = Buffer.from(`${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const request = () =>
    axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 30000, // the Safaricom sandbox is often slow
    });
  let data;
  try {
    ({ data } = await request());
  } catch (e) {
    // One automatic retry for slow/dropped connections (getting a token is safe to repeat).
    const transient = !e.response || e.code === "ECONNABORTED" || e.code === "ECONNRESET" || e.code === "ETIMEDOUT";
    if (!transient) throw e;
    console.warn("M-Pesa token request failed (" + (e.code || e.message) + "), retrying once…");
    ({ data } = await request());
  }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000,
  };
  return cachedToken.token;
}

// YYYYMMDDHHmmss in East Africa Time (UTC+3)
function timestamp() {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

const password = (ts) => Buffer.from(`${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${ts}`).toString("base64");

function callbackUrl() {
  const u = new URL(env.MPESA_CALLBACK_URL);
  u.searchParams.set("token", env.MPESA_CALLBACK_TOKEN);
  return u.toString();
}

function describeError(e) {
  const d = e.response?.data;
  return d?.errorMessage || d?.ResponseDescription || e.message;
}

// Initiates the STK Push prompt. A successful response only means Safaricom ACCEPTED the
// request: the order is paid only when the callback confirms it.
export async function stkPush({ phone, amount, reference }) {
  assertConfigured();
  try {
    const token = await getAccessToken();
    const ts = timestamp();
    const { data } = await axios.post(
      `${BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: password(ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: callbackUrl(),
        AccountReference: String(reference).slice(-12), // Daraja limit: 12 chars
        TransactionDesc: "Service order", // Daraja limit: 13 chars
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 } // not retried: a retry could send a second prompt
    );
    console.log("STK push response:", {
      env: env.MPESA_ENVIRONMENT,
      phone: `${phone.slice(0, 5)}***${phone.slice(-3)}`,
      amount,
      ResponseCode: data.ResponseCode,
      ResponseDescription: data.ResponseDescription,
      CustomerMessage: data.CustomerMessage,
      CheckoutRequestID: data.CheckoutRequestID,
    });
    if (String(data.ResponseCode) !== "0") {
      throw new HttpError(502, data.ResponseDescription || "M-Pesa rejected the request");
    }
    return { merchantRequestId: data.MerchantRequestID, checkoutRequestId: data.CheckoutRequestID };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("STK push failed:", e.response?.data || e.message);
    throw new HttpError(502, `Could not start M-Pesa payment: ${describeError(e)}`);
  }
}

// Status query used only to detect failed/cancelled prompts. It never marks anything as paid.
export async function stkQuery(checkoutRequestId) {
  assertConfigured();
  const token = await getAccessToken();
  const ts = timestamp();
  const { data } = await axios.post(
    `${BASE}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: env.MPESA_SHORTCODE,
      Password: password(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
  );
  return data;
}