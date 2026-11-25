import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AlertTriangle, ShieldCheck, Truck } from "lucide-react";
import { prisma } from "@/lib/db";
import { SLUG_PARAM_RE } from "@/lib/validators";
import { getT } from "@/lib/i18n/server";
import { localizeCategoryName } from "@/lib/i18n/translate";
import { getCurrentUser } from "@/lib/auth/session";
import { toCards, productCardInclude } from "@/lib/catalog";
import { sellableCutoff } from "@/lib/services/inventory";
import { formatDate } from "@/lib/date";
import { ProductCard } from "@/components/shop/product-card";
import { ProductImage } from "@/components/common/product-image";
import { Price } from "@/components/common/price";
import { Badge } from "@/components/ui/badge";
import { AddToCart } from "@/components/shop/add-to-cart";
import { ReviewBox } from "@/components/shop/review-box";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  if (!SLUG_PARAM_RE.test(slug)) return null;
  return prisma.medicine.findFirst({ where: { slug, deletedAt: null, isActive: true }, include: { ...productCardInclude, reviews: { where: { isVisible: true }, include: { customer: { include: { user: { select: { name: true } } } } }, take: 10, orderBy: { createdAt: "desc" } } } });
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const m = await load((await params).slug);
  return m ? { title: m.nameEn, description: m.descriptionEn ?? undefined } : {};
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const m = await load(slug);
  if (!m) notFound();
  const { t, tryT, locale } = await getT();
  const user = await getCurrentUser();
  const [card] = await toCards([m]);
  const nearest = await prisma.medicineBatch.findFirst({ where: { medicineId: m.id, quantity: { gt: 0 }, expiryDate: { gte: sellableCutoff() } }, orderBy: { expiryDate: "asc" }, select: { expiryDate: true } });
  const related = await toCards(await prisma.medicine.findMany({ where: { categoryId: m.categoryId, id: { not: m.id }, deletedAt: null, isActive: true }, take: 4, orderBy: { soldCount: "desc" }, include: productCardInclude }));
  const wished = user?.customerId ? !!(await prisma.wishlistItem.findUnique({ where: { customerId_medicineId: { customerId: user.customerId, medicineId: m.id } } })) : false;
  const name = locale === "km" ? m.nameKm : m.nameEn;
  const desc = (locale === "km" ? m.descriptionKm : m.descriptionEn) ?? m.descriptionEn;
  const rows: [string, string | null | undefined][] = [
    [t("product.sku"), m.sku], [t("product.barcode"), m.barcode], [t("product.brand"), m.brand?.name], [t("product.manufacturer"), m.manufacturer],
    [t("product.category"), localizeCategoryName(m.category, locale, tryT)], [t("product.dosageForm"), m.dosageForm], [t("product.strength"), m.strength], [t("product.unit"), m.unit],
    [t("product.expiry"), m.tracksExpiry && nearest ? formatDate(nearest.expiryDate) : null],
  ];
  const avgRating = m.reviews.length ? m.reviews.reduce((s, r) => s + r.rating, 0) / m.reviews.length : 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <nav className="mb-4 text-xs text-muted-foreground">
        <Link href="/" className="hover:text-primary">{t("common.home")}</Link> / <Link href={`/shop?category=${encodeURIComponent(m.category.slug)}`} className="hover:text-primary">{localizeCategoryName(m.category, locale, tryT)}</Link> / <span>{name}</span>
      </nav>
      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-3">
          <ProductImage src={m.imageUrl} alt={name} className="aspect-square w-full rounded-3xl border" sizes="(max-width:768px) 100vw, 50vw" priority />
          <p className="text-[11px] text-muted-foreground">{t("common.packagingMayVary")}</p>
        </div>
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            {m.requiresPrescription ? <Badge className="bg-amber-500 text-white"><AlertTriangle className="size-3" /> {t("product.rxRequired")}</Badge> : <Badge variant="secondary">{t("product.otc")}</Badge>}
            {m.brand && <Badge variant="outline">{m.brand.name}</Badge>}
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight md:text-3xl">{name}</h1>
            {locale === "km" ? <p className="mt-1 text-muted-foreground">{m.nameEn}</p> : <p className="mt-1 text-muted-foreground">{m.nameKm}</p>}
            {m.genericName && <p className="text-sm text-muted-foreground">{m.genericName}</p>}
          </div>
          <Price usd={card.price} compareAt={card.compareAtPrice} size="lg" />
          {m.requiresPrescription && (
            <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="size-5 shrink-0" /><p>{t("product.rxWarning")}</p>
            </div>
          )}
          <AddToCart product={card} wished={wished} canWish={!!user?.customerId} />
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="flex items-center gap-2 rounded-xl bg-secondary p-3"><ShieldCheck className="size-4 text-primary" /> {t("home.why2")}</div>
            <div className="flex items-center gap-2 rounded-xl bg-accent p-3"><Truck className="size-4 text-brand-blue" /> {t("home.why3")}</div>
          </div>
          <dl className="divide-y rounded-2xl border bg-white text-sm">
            {rows.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
            ))}
          </dl>
        </div>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {[[t("product.description"), desc], [t("product.ingredients"), m.activeIngredients], [t("product.dosage"), m.dosageInfo], [t("product.usage"), m.usageInstructions]].filter(([, v]) => v).map(([k, v]) => (
            <section key={k as string} className="rounded-2xl border bg-white p-5"><h2 className="mb-2 font-semibold">{k}</h2><p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{v}</p></section>
          ))}
          {m.warnings && (
            <section className="rounded-2xl border border-red-200 bg-red-50 p-5"><h2 className="mb-2 flex items-center gap-2 font-semibold text-red-800"><AlertTriangle className="size-4" /> {t("product.warnings")}</h2><p className="whitespace-pre-line break-words text-sm text-red-900">{m.warnings}</p></section>
          )}
          <p className="text-xs text-muted-foreground">{t("product.consult")}</p>
        </div>
        <section className="h-fit rounded-2xl border bg-white p-5">
          <h2 className="mb-3 font-semibold">{t("product.reviews")} {m.reviews.length > 0 && <span className="text-sm text-muted-foreground">★ {avgRating.toFixed(1)} ({m.reviews.length})</span>}</h2>
          {m.reviews.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : m.reviews.map((r) => (
            <div key={r.id} className="border-t py-3 text-sm first:border-0"><div className="font-medium">{"★".repeat(r.rating)}<span className="text-muted-foreground">{"★".repeat(5 - r.rating)}</span> · {r.customer.user.name}</div>{r.comment && <p className="whitespace-pre-line break-words text-muted-foreground">{r.comment}</p>}</div>
          ))}
        <ReviewBox slug={m.slug} canReview={!!user?.customerId} />
        </section>
      </div>

      {related.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-5 text-xl font-bold">{t("product.related")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">{related.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </div>
  );
}
