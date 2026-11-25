"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, Search, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ProductImage } from "@/components/common/product-image";
import { PageHeader, Pagination } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import { api } from "@/lib/fetcher";

type MedRow = {
  id: string; sku: string; barcode: string | null; nameEn: string; nameKm: string; price: string; costPrice: string;
  imageUrl: string | null; requiresPrescription: boolean; isActive: boolean; isFeatured: boolean; sellable: number;
  category: { nameEn: string }; brand: { name: string } | null; inventory: { quantity: number; reserved: number; minStock: number } | null;
};

export function MedicinesClient({ categories, canWrite }: { categories: { id: string; nameEn: string }[]; canWrite: boolean }) {
  const { locale, money } = useI18n();
  const km = locale === "km";
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [rx, setRx] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; items: MedRow[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const sp = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (q) sp.set("q", q);
    if (category) sp.set("category", category);
    if (status) sp.set("status", status);
    if (rx) sp.set("rx", rx);
    api<{ total: number; pageSize: number; items: MedRow[] }>(`/api/admin/medicines?${sp}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [q, category, status, rx, page]);

  useEffect(() => {
    const id = setTimeout(load, 200);
    return () => clearTimeout(id);
  }, [load]);

  const sel = "h-9 rounded-md border bg-white px-3 text-sm";

  return (
    <div>
      <PageHeader
        title={km ? "គ្រប់គ្រងឱសថ" : "Medicines"}
        subtitle={km ? "បញ្ជីឱសថ តម្លៃ SKU និងតម្រូវការវេជ្ជបញ្ជា" : "Manage pharmacy catalogue, pricing, SKUs and prescription rules"}
        actions={canWrite && <Button asChild><Link href="/admin/medicines/new"><Plus /> {km ? "បន្ថែមឱសថ" : "Add Medicine"}</Link></Button>}
      />

      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border bg-white p-3 shadow-sm">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, Khmer name, SKU, barcode…" className="pl-9" />
        </div>
        <select className={sel} value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
        </select>
        <select className={sel} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All stock / status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
        <select className={sel} value={rx} onChange={(e) => { setRx(e.target.value); setPage(1); }}>
          <option value="">Rx & OTC</option>
          <option value="rx">Prescription only</option>
          <option value="otc">Over the counter</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Medicine</th><th className="p-3">SKU / Barcode</th><th className="p-3">Category</th>
              <th className="p-3 text-right">Cost</th><th className="p-3 text-right">Price</th><th className="p-3 text-right">Sellable</th><th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && !data && <tr><td colSpan={7} className="p-10 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></td></tr>}
            {data?.items.map((m) => (
              <tr key={m.id} className="hover:bg-muted/30">
                <td className="p-3">
                  <Link href={`/admin/medicines/${m.id}`} className="flex items-center gap-3">
                    <ProductImage src={m.imageUrl} alt={m.nameEn} className="size-11 shrink-0 rounded-lg" sizes="44px" />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground hover:text-primary">{m.nameEn}</div>
                      <div className="truncate text-xs text-muted-foreground">{m.nameKm}</div>
                    </div>
                  </Link>
                </td>
                <td className="p-3 font-mono text-xs"><div>{m.sku}</div>{m.barcode && <div className="text-muted-foreground">{m.barcode}</div>}</td>
                <td className="p-3 text-xs"><div>{m.category.nameEn}</div>{m.brand && <div className="text-muted-foreground">{m.brand.name}</div>}</td>
                <td className="p-3 text-right text-muted-foreground">{money(m.costPrice)}</td>
                <td className="p-3 text-right font-semibold">{money(m.price)}</td>
                <td className="p-3 text-right">
                  <span className={m.sellable <= 0 ? "font-bold text-red-600" : m.sellable <= (m.inventory?.minStock ?? 0) ? "font-bold text-amber-600" : "font-medium text-primary"}>{m.sellable}</span>
                  {m.inventory && m.inventory.reserved > 0 && <div className="text-[10px] text-muted-foreground">{m.inventory.reserved} res.</div>}
                </td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1">
                    {m.requiresPrescription && <Badge className="bg-amber-500 text-white"><AlertTriangle className="size-3" /> Rx</Badge>}
                    {!m.isActive && <Badge variant="secondary">Hidden</Badge>}
                    {m.isActive && <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Active</Badge>}
                  </div>
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">No medicines match your filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}
