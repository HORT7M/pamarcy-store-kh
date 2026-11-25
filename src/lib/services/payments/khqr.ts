import "server-only";
import { BakongKHQR, IndividualInfo, MerchantInfo, khqrData } from "bakong-khqr";
import type { KhqrConfig } from "./config";
import { ApiError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";

/**
 * KHQR (Bakong) integration.
 * - QR strings are generated locally per EMVCo/KHQR spec with the merchant's Bakong account.
 * - Payment status is ONLY confirmed through NBC's Bakong Open API (`/v1/check_transaction_by_md5`)
 *   using the merchant API token (server-side env var). No status is ever inferred client-side.
 */

export type KhqrGenerated = { qr: string; md5: string; currency: "USD" | "KHR"; amount: number; accountId: string };

export function generateKhqr(cfg: KhqrConfig, p: { amount: number; currency: "USD" | "KHR"; billNumber: string; expiresAt: Date }): KhqrGenerated {
  const accountId = cfg.accountId || serverEnv.bakong.accountId;
  if (!accountId) throw new ApiError(503, "KHQR_NOT_CONFIGURED", "KHQR merchant account is not configured");
  const optional: Record<string, unknown> = {
    currency: p.currency === "USD" ? khqrData.currency.usd : khqrData.currency.khr,
    amount: p.amount,
    billNumber: p.billNumber.slice(0, 25),
    storeLabel: cfg.merchantName.slice(0, 25),
    terminalLabel: "Online",
    mobileNumber: cfg.mobileNumber?.replace(/^\+/, "") || undefined,
    expirationTimestamp: p.expiresAt.getTime(),
    merchantCategoryCode: "5912", // Drug stores and pharmacies
  };
  const khqr = new BakongKHQR();
  const res =
    cfg.merchantType === "merchant" && cfg.merchantId && cfg.acquiringBank
      ? khqr.generateMerchant(new MerchantInfo(accountId, cfg.merchantName, cfg.merchantCity, cfg.merchantId, cfg.acquiringBank, optional))
      : khqr.generateIndividual(new IndividualInfo(accountId, cfg.merchantName, cfg.merchantCity, optional));
  if (!res.data || res.status.code !== 0) {
    throw new ApiError(500, "KHQR_GENERATION_FAILED", res.status.message ?? "Failed to generate KHQR");
  }
  return { qr: res.data.qr, md5: res.data.md5, currency: p.currency, amount: p.amount, accountId };
}

export type BakongCheckResult =
  | { state: "paid"; hash: string; amount: number; currency: string; toAccountId: string; fromAccountId?: string; raw: unknown }
  | { state: "not_found"; raw: unknown }
  | { state: "failed"; message: string; raw: unknown };

export async function checkBakongTransaction(md5: string): Promise<BakongCheckResult> {
  const token = serverEnv.bakong.apiToken;
  if (!token) throw new ApiError(503, "KHQR_NOT_CONFIGURED", "KHQR payment verification is not configured");
  const base = serverEnv.bakong.apiBase;
  const res = await fetch(`${base}/v1/check_transaction_by_md5`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ md5 }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) throw new ApiError(502, "KHQR_AUTH", "Bakong API token rejected (expired or invalid)");
  if (!res.ok) throw new ApiError(502, "KHQR_UPSTREAM", `Bakong API error ${res.status}`);
  const body = (await res.json()) as {
    responseCode: number;
    responseMessage?: string;
    errorCode?: number | null;
    data?: { hash: string; fromAccountId?: string; toAccountId: string; currency: string; amount: number } | null;
  };
  if (body.responseCode === 0 && body.data) {
    return { state: "paid", hash: body.data.hash, amount: Number(body.data.amount), currency: body.data.currency, toAccountId: body.data.toAccountId, fromAccountId: body.data.fromAccountId, raw: body };
  }
  // errorCode 1 = transaction not found (yet); 3 = transaction failed
  if (body.errorCode === 3) return { state: "failed", message: body.responseMessage ?? "Transaction failed", raw: body };
  return { state: "not_found", raw: body };
}
