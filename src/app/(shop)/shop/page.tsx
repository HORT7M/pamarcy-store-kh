import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { searchProducts } from "@/lib/catalog";
import { ProductCard } from "@/components/shop/product-card";
import { EmptyState } from "@/components/common/empty-state";
import { ShopFilters } from "@/components/shop/shop-filters";
import { normalizeSingleLineText } from "@/lib/sanitize";
import { CATEGORY_SLUG_RE } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shop" };

type SP = Record<string, string | string[] | undefined>;
const ALLOWED_SORTS = new Set(["popular", "newest", "price_asc", "price_desc", "name"]);

function firstStr(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

function safePrice(raw?: string): number | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : undefined;
}

function safePage(raw?: string): number {
  if (!raw) return 1;
  const t = raw.trim();
  if (!/^\d{1,5}$/.test(t)) return 1;
  const n = Number(t);
  return Number.isSafeInteger(n) ? Math.min(10_000, Math.max(1, n)) : 1;
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const rawQ = firstStr(sp.q);
  const safeQ = rawQ ? normalizeSingleLineText(rawQ, 100) : "";
  const rawCat = firstStr(sp.category)?.trim();
  const category = rawCat && rawCat.length <= 100 && CATEGORY_SLUG_RE.test(rawCat) ? rawCat : undefined;
  const rawBrand = firstStr(sp.brand)?.trim();
  const brandList = rawBrand
    ? rawBrand
        .split(",")
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && b.length <= 100 && CATEGORY_SLUG_RE.test(b))
        .slice(0, 20)
    : undefined;
  let minPrice = safePrice(firstStr(sp.min));
  let maxPrice = safePrice(firstStr(sp.max));
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  const rawSort = firstStr(sp.sort)?.trim();
  const sort = rawSort && ALLOWED_SORTS.has(rawSort) ? rawSort : undefined;
  const inStock = firstStr(sp.stock) === "1";
  const rawRx = firstStr(sp.rx);
  const rx = rawRx === "rx" || rawRx === "otc" ? rawRx : undefined;
  const offers = firstStr(sp.offers) === "1";
  const page = safePage(firstStr(sp.page));

  const [result, categories, brands] = await Promise.all([
    searchProducts({
      q: safeQ || undefined,
      category,
      brand: brandList?.length ? brandList : undefined,
      minPrice,
      maxPrice,
      sort,
      inStock,
      rx,
      offers,
      page,
      pageSize: 12,
    }),
    prisma.category.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { sortOrder: "asc" }, select: { slug: true, nameEn: true, nameKm: true } }),
    prisma.brand.findMany({ where: { deletedAt: null, medicines: { some: { deletedAt: null, isActive: true } } }, orderBy: { name: "asc" }, select: { slug: true, name: true } }),
  ]);
  const cat = categories.find((c) => c.slug === category);
  const title = safeQ ? `“${safeQ}”` : cat ? (locale === "km" ? cat.nameKm : cat.nameEn) : offers ? t("nav.offers") : t("shop.title");

  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (safeQ) u.set("q", safeQ);
    if (category) u.set("category", category);
    if (brandList?.length) u.set("brand", brandList.join(","));
    if (minPrice !== undefined) u.set("min", String(minPrice));
    if (maxPrice !== undefined) u.set("max", String(maxPrice));
    if (sort) u.set("sort", sort);
    if (inStock) u.set("stock", "1");
    if (rx) u.set("rx", rx);
    if (offers) u.set("offers", "1");
    u.set("page", String(p));
    return `/shop?${u}`;
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <nav className="mb-3 text-xs text-muted-foreground"><Link href="/" className="hover:text-primary">{t("common.home")}</Link> / <span>{t("common.shop")}</span></nav>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-bold">{title}</h1>
        <span className="text-sm text-muted-foreground">{t("shop.results", { n: result.total })}</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <ShopFilters categories={categories} brands={brands} />
        <div>
          {result.items.length === 0 ? (
            <EmptyState icon={PackageSearch} title={t("common.noResults")} action={<Link href="/shop" className="text-sm font-medium text-primary hover:underline">{t("common.reset")}</Link>} />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">{result.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
          )}
          {result.pages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-2 text-sm">
              {page > 1 && <Link href={qs(page - 1)} className="rounded-full border px-4 py-2 hover:bg-secondary">{t("common.previous")}</Link>}
              <span className="px-3 text-muted-foreground">{t("common.page")} {page} {t("common.of")} {result.pages}</span>
              {page < result.pages && <Link href={qs(page + 1)} className="rounded-full border px-4 py-2 hover:bg-secondary">{t("common.next")}</Link>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
