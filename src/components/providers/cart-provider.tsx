"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { normalizeSingleLineText, safeImageSrc, safePathSegment } from "@/lib/sanitize";

export type CartItem = {
  medicineId: string;
  slug: string;
  nameEn: string;
  nameKm: string;
  imageUrl: string | null;
  price: number;
  quantity: number;
  maxQty: number;
  requiresPrescription: boolean;
};

type Ctx = {
  items: CartItem[];
  count: number;
  subtotal: number;
  ready: boolean;
  add: (item: Omit<CartItem, "quantity">, qty?: number) => void;
  setQty: (medicineId: string, qty: number) => void;
  remove: (medicineId: string) => void;
  clear: () => void;
  discountCode: string;
  setDiscountCode: (c: string) => void;
};

const CartCtx = createContext<Ctx | null>(null);
const KEY = "pamarcy_cart_v1";

function sanitizeStoredItem(raw: unknown): CartItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const medicineId = typeof o.medicineId === "string" ? normalizeSingleLineText(o.medicineId, 64) : "";
  if (!medicineId) return null;
  const rawSlug = typeof o.slug === "string" ? o.slug.trim() : "";
  const slug = rawSlug && safePathSegment(rawSlug) ? rawSlug.slice(0, 120) : "";
  const price = Number(o.price);
  const quantity = Math.floor(Number(o.quantity));
  const maxQty = Math.floor(Number(o.maxQty));
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity < 1) return null;
  return {
    medicineId,
    slug,
    nameEn: normalizeSingleLineText(o.nameEn, 200),
    nameKm: normalizeSingleLineText(o.nameKm, 200),
    imageUrl: safeImageSrc(typeof o.imageUrl === "string" ? o.imageUrl : null),
    price,
    quantity: Math.min(999, quantity),
    maxQty: Number.isFinite(maxQty) && maxQty > 0 ? Math.min(999, maxQty) : 999,
    requiresPrescription: Boolean(o.requiresPrescription),
  };
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [discountCode, setDiscountCode] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { items?: unknown; discountCode?: unknown };
        const sanitized = Array.isArray(parsed.items)
          ? parsed.items.slice(0, 100).map(sanitizeStoredItem).filter((i): i is CartItem => i !== null)
          : [];
        setItems(sanitized);
        setDiscountCode(typeof parsed.discountCode === "string" ? normalizeSingleLineText(parsed.discountCode, 40) : "");
      }
    } catch {
      /* ignore corrupted storage */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(KEY, JSON.stringify({ items, discountCode }));
  }, [items, discountCode, ready]);

  const add = useCallback((item: Omit<CartItem, "quantity">, qty = 1) => {
    const cleanImage = safeImageSrc(item.imageUrl);
    const cleanSlug = item.slug && safePathSegment(item.slug) ? item.slug : "";
    const safeItem = { ...item, imageUrl: cleanImage, slug: cleanSlug };
    setItems((prev) => {
      const ex = prev.find((i) => i.medicineId === safeItem.medicineId);
      if (ex) return prev.map((i) => (i.medicineId === safeItem.medicineId ? { ...i, ...safeItem, quantity: Math.min(i.quantity + qty, safeItem.maxQty || 999) } : i));
      return [...prev, { ...safeItem, quantity: Math.min(qty, safeItem.maxQty || 999) }];
    });
  }, []);
  const setQty = useCallback((id: string, qty: number) => {
    setItems((prev) => prev.map((i) => (i.medicineId === id ? { ...i, quantity: Math.max(1, Math.min(qty, 999)) } : i)));
  }, []);
  const remove = useCallback((id: string) => setItems((prev) => prev.filter((i) => i.medicineId !== id)), []);
  const clear = useCallback(() => {
    setItems([]);
    setDiscountCode("");
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      items, ready, add, setQty, remove, clear, discountCode, setDiscountCode,
      count: items.reduce((s, i) => s + i.quantity, 0),
      subtotal: Math.round(items.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100,
    }),
    [items, ready, add, setQty, remove, clear, discountCode],
  );
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}

export function useCart() {
  const c = useContext(CartCtx);
  if (!c) throw new Error("useCart must be used inside CartProvider");
  return c;
}
