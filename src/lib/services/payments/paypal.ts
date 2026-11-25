import "server-only";
import { ApiError } from "@/lib/errors";
import { safePaypalApproveUrl } from "@/lib/sanitize";
import { serverEnv } from "@/lib/env";

/**
 * PayPal Checkout – Orders v2 REST API.
 * Orders are created and captured exclusively on the server; the browser only receives the
 * PayPal order id to render the PayPal buttons. Webhooks are verified with
 * /v1/notifications/verify-webhook-signature.
 */

function base() {
  return serverEnv.paypal.apiBase;
}

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const id = serverEnv.paypal.clientId;
  const secret = serverEnv.paypal.clientSecret;
  if (!id || !secret) throw new ApiError(503, "PAYPAL_NOT_CONFIGURED", "PayPal is not configured");
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new ApiError(502, "PAYPAL_AUTH", "PayPal authentication failed");
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const token = await accessToken();
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

export type PaypalOrder = {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    amount?: { currency_code: string; value: string };
    payments?: { captures?: { id: string; status: string; amount: { currency_code: string; value: string } }[] };
  }[];
  payer?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
  links?: { href: string; rel: string; method?: string }[];
};

export function approvalUrl(o: PaypalOrder): string | null {
  const raw = o.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return safePaypalApproveUrl(raw);
}

export async function createPaypalOrder(p: { reference: string; orderNumber: string; amountUsd: string; brandName: string; returnUrl: string; cancelUrl: string }) {
  const { status, data } = await call<PaypalOrder & { message?: string }>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: p.reference,
          custom_id: p.reference,
          invoice_id: p.reference,
          description: `Pamarcy Store order ${p.orderNumber}`,
          amount: { currency_code: "USD", value: p.amountUsd },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: p.brandName.slice(0, 127),
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: p.returnUrl,
            cancel_url: p.cancelUrl,
          },
        },
      },
    },
    { "PayPal-Request-Id": `create-${p.reference}` },
  );
  if (status >= 300) throw new ApiError(502, "PAYPAL_CREATE_FAILED", data.message ?? "Could not create PayPal order");
  return data;
}

export async function getPaypalOrder(id: string) {
  const { status, data } = await call<PaypalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
  if (status >= 300) throw new ApiError(502, "PAYPAL_LOOKUP_FAILED", "Could not fetch PayPal order");
  return data;
}

export async function capturePaypalOrder(id: string, reference: string) {
  const { status, data } = await call<PaypalOrder & { name?: string; details?: { issue: string; description: string }[] }>(
    "POST",
    `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
    {},
    { "PayPal-Request-Id": `capture-${reference}` },
  );
  // ORDER_ALREADY_CAPTURED → fetch the order to read the capture
  if (status === 422 && data.details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED")) return getPaypalOrder(id);
  if (status >= 300) {
    const issue = data.details?.[0];
    throw new ApiError(402, issue?.issue ?? "PAYPAL_CAPTURE_FAILED", issue?.description ?? "PayPal capture failed");
  }
  return data;
}

export async function refundPaypalCapture(captureId: string, amountUsd: string, reference: string) {
  const { status, data } = await call<{ id: string; status: string; message?: string }>(
    "POST",
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { amount: { value: amountUsd, currency_code: "USD" }, note_to_payer: "Refund from Pamarcy Store" },
    { "PayPal-Request-Id": `refund-${reference}` },
  );
  if (status >= 300) throw new ApiError(502, "PAYPAL_REFUND_FAILED", data.message ?? "PayPal refund failed");
  return data;
}

export async function verifyPaypalWebhook(headers: Headers, rawBody: string): Promise<boolean> {
  const webhookId = serverEnv.paypal.webhookId;
  if (!webhookId) return false;
  const get = (k: string) => headers.get(k) ?? "";
  const { status, data } = await call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: get("paypal-auth-algo"),
    cert_url: get("paypal-cert-url"),
    transmission_id: get("paypal-transmission-id"),
    transmission_sig: get("paypal-transmission-sig"),
    transmission_time: get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: JSON.parse(rawBody),
  });
  return status === 200 && data.verification_status === "SUCCESS";
}
