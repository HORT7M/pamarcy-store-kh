import { apiHandler, assertSafeJsonStructure, readBodyTextWithLimit } from "@/lib/api";
import { badRequest, unauthorized, unsupportedMedia } from "@/lib/errors";
import { verifyPaypalWebhook } from "@/lib/services/payments/paypal";
import { handlePaypalWebhook } from "@/lib/services/payments";
import { paypalWebhookEventSchema } from "@/lib/validators";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const PAYPAL_CERT_HOSTS = new Set(["api.paypal.com", "api.sandbox.paypal.com", "api-m.paypal.com", "api-m.sandbox.paypal.com"]);

function assertPaypalHeaders(headers: Headers) {
  const required = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ];
  for (const h of required) {
    const val = headers.get(h)?.trim();
    if (!val || val.length > 2048 || /[\x00-\x1f\x7f]/.test(val)) {
      throw unauthorized("Missing or malformed PayPal signature headers");
    }
  }
  try {
    const certUrl = new URL(headers.get("paypal-cert-url")!.trim());
    if (certUrl.protocol !== "https:" || !PAYPAL_CERT_HOSTS.has(certUrl.hostname.toLowerCase())) {
      throw unauthorized("Untrusted PayPal certificate URL");
    }
  } catch (e) {
    if (e instanceof Error && "status" in e) throw e;
    throw unauthorized("Invalid PayPal certificate URL");
  }
}

/** POST /api/webhooks/paypal – signature-verified, schema-validated PayPal webhook */
export const POST = apiHandler(
  async (req) => {
    const ct = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (ct !== "application/json" && !(ct.startsWith("application/") && ct.endsWith("+json"))) {
      throw unsupportedMedia("Content-Type must be application/json");
    }

    assertPaypalHeaders(req.headers);

    const raw = await readBodyTextWithLimit(req, MAX_WEBHOOK_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badRequest("Invalid JSON webhook payload");
    }
    assertSafeJsonStructure(parsed);
    const event = paypalWebhookEventSchema.parse(parsed);

    const valid = await verifyPaypalWebhook(req.headers, raw);
    if (!valid) throw unauthorized("Invalid webhook signature");

    return handlePaypalWebhook(event);
  },
  { skipCsrf: true, rateLimit: { limit: 120, windowMs: 60_000, keyPrefix: "webhooks:paypal" } },
);
