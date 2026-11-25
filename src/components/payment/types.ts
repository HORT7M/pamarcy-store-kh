export type PaymentViewDto = {
  id: string; reference: string; method: "KHQR" | "USDT" | "PAYPAL" | "CASH"; status: "PENDING" | "PROCESSING" | "PAID" | "FAILED" | "EXPIRED" | "REFUNDED";
  currency: string; amount: string; amountUsd: string; network: { code: string; label: string; contract: string; confirmations: number; explorer: string } | null;
  payTo: string | null; qrDataUrl: string | null; paypalOrderId: string | null; paypalApproveUrl: string | null; txHash: string | null; providerTxnId: string | null;
  failureReason: string | null; merchant: { name: string; city: string; account: string } | null; expiresAt: string | null; paidAt: string | null; createdAt: string;
};

export type MethodDto = { code: "KHQR" | "USDT" | "PAYPAL" | "CASH"; nameEn: string; nameKm: string; ready: boolean; reason?: string; networks?: { code: string; label: string }[]; currencies?: string[] };
