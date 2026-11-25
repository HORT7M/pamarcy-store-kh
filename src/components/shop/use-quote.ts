"use client";

import { useEffect, useState } from "react";
import { api, FetchError } from "@/lib/fetcher";
import { parseBotChallengeError, type ClientBotPayload } from "@/lib/bot-client";
import type { CartItem } from "@/components/providers/cart-provider";

export type Quote = {
  lines: { medicineId: string; nameEn: string; nameKm: string; slug: string; imageUrl: string | null; unitPrice: number; quantity: number; lineTotal: number; available: number; requiresPrescription: boolean }[];
  subtotal: number; discountAmount: number; discountCode: string | null; discountError: string | null; deliveryFee: number; total: number; requiresPrescription: boolean; freeDeliveryThreshold: number; stockOk: boolean;
};

/** Debounced server-side price/stock/discount quote. */
export function useQuote(
  items: CartItem[],
  discountCode: string,
  province: string | null,
  ready: boolean,
  opts?: { botPayload?: ClientBotPayload; attemptKey?: number; onPromoError?: (err: FetchError) => void },
) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([items.map((i) => [i.medicineId, i.quantity]), discountCode, province, opts?.attemptKey ?? 0]);

  useEffect(() => {
    if (!ready) return;
    if (!items.length) { setQuote(null); return; }
    let cancelled = false;
    setLoading(true);
    const id = setTimeout(() => {
      const payloadItems = items.map((i) => ({ medicineId: i.medicineId, quantity: i.quantity }));
      api<Quote>("/api/cart/quote", {
        method: "POST",
        body: {
          items: payloadItems,
          discountCode: discountCode || null,
          province,
          ...(discountCode && opts?.botPayload ? { _bot: opts.botPayload } : {}),
        },
      })
        .then((q) => {
          if (!cancelled) { setQuote(q); setError(null); }
        })
        .catch(async (e: unknown) => {
          if (cancelled) return;
          const fe = e as FetchError;
          // If promo code guessing triggered CAPTCHA / throttling, keep cart quoting usable without discount
          if (discountCode && (parseBotChallengeError(fe).required || fe.status === 429)) {
            opts?.onPromoError?.(fe);
            try {
              const fallback = await api<Quote>("/api/cart/quote", {
                method: "POST",
                body: { items: payloadItems, discountCode: null, province },
              });
              if (!cancelled) {
                setQuote({ ...fallback, discountError: fe.message });
                setError(null);
              }
              return;
            } catch {
              /* fall through to normal error */
            }
          }
          setError(fe.message);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);
  return { quote, loading, error };
}
