import Link from "next/link";
import Image from "next/image";
import { ShieldCheck, BadgeCheck, Truck, CreditCard, ArrowRight, FileText } from "lucide-react";
import { prisma } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { localizeBanner, localizeCategoryName } from "@/lib/i18n/translate";
import { searchProducts } from "@/lib/catalog";
import { ProductCard } from "@/components/shop/product-card";
import { Button } from "@/components/ui/button";
import { Suspense } from "react";
import { SearchBar } from "@/components/shop/search-bar";
import { safeImageSrc, safeNavigationHref } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

function Section({ title, href, children, viewAll }: { title: string; href: string; children: React.ReactNode; viewAll: string }) {
  return (
    <section className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-5 flex items-end justify-between">
        <h2 className="text-xl font-bold tracking-tight md:text-2xl">{title}</h2>
        <Link href={href} className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">{viewAll} <ArrowRight className="size-4" /></Link>
      </div>
      {children}
    </section>
  );
}

export default async function HomePage() {
  const { t, tryT, locale } = await getT();
  const [categories, banners, featured, best, newest, offers] = await Promise.all([
    prisma.category.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { sortOrder: "asc" }, include: { _count: { select: { medicines: { where: { deletedAt: null, isActive: true } } } } } }),
    prisma.banner.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, take: 3 }),
    searchProducts({ featured: true, pageSize: 8, sort: "popular" }),
    searchProducts({ sort: "popular", pageSize: 8 }),
    searchProducts({ sort: "newest", pageSize: 4 }),
    searchProducts({ offers: true, pageSize: 4 }),
  ]);
  const L = (o: { slug?: string; nameEn: string; nameKm: string }) => localizeCategoryName(o, locale, tryT);
  const grid = "grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4";
  const why = [
    { icon: ShieldCheck, title: t("home.why1"), d: t("home.why1d") },
    { icon: BadgeCheck, title: t("home.why2"), d: t("home.why2d") },
    { icon: Truck, title: t("home.why3"), d: t("home.why3d") },
    { icon: CreditCard, title: t("home.why4"), d: t("home.why4d") },
  ];

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-secondary via-white to-accent">
        <div className="mx-auto grid max-w-7xl items-center gap-8 px-4 py-10 md:grid-cols-2 md:py-16">
          <div className="space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-primary shadow-sm"><ShieldCheck className="size-4" /> {t("home.why1")}</span>
            <h1 className="text-3xl font-extrabold leading-tight tracking-tight md:text-5xl">{t("home.heroTitle")}</h1>
            <p className="max-w-lg text-muted-foreground md:text-lg">{t("home.heroSubtitle")}</p>
            <Suspense><SearchBar large className="max-w-lg" /></Suspense>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="rounded-full"><Link href="/shop">{t("home.shopNow")} <ArrowRight /></Link></Button>
              <Button asChild size="lg" variant="outline" className="rounded-full border-primary text-primary"><Link href="/shop?category=prescription-medicines"><FileText /> {t("home.uploadRx")}</Link></Button>
            </div>
          </div>
          <div className="relative aspect-[4/3] overflow-hidden rounded-3xl shadow-xl">
            <Image src="/images/banners/hero-pharmacy.jpg" alt={t("home.heroImgAlt")} fill priority sizes="(max-width:768px) 100vw, 50vw" className="object-cover" />
            <div className="absolute bottom-4 left-4 rounded-2xl bg-white/95 px-4 py-3 shadow-lg">
              <div className="text-2xl font-bold text-primary">25</div>
              <div className="text-xs text-muted-foreground">{t("home.provincesDelivered")}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Why us */}
      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {why.map((w) => (
            <div key={w.title} className="flex gap-3 rounded-2xl border bg-white p-4 shadow-sm">
              <div className="h-fit rounded-xl bg-secondary p-2.5"><w.icon className="size-5 text-primary" /></div>
              <div><div className="text-sm font-semibold">{w.title}</div><div className="mt-0.5 hidden text-xs text-muted-foreground sm:block">{w.d}</div></div>
            </div>
          ))}
        </div>
      </section>

      {/* Categories */}
      <Section title={t("home.shopByCategory")} href="/shop" viewAll={t("common.viewAll")}>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-9">
          {categories.map((c) => {
            const catImg = safeImageSrc(c.imageUrl);
            return (
              <Link key={c.id} href={`/shop?category=${encodeURIComponent(c.slug)}`} className="group flex flex-col items-center gap-2 rounded-2xl border bg-white p-3 text-center shadow-sm transition hover:border-primary hover:shadow-md">
                <div className="relative size-16 overflow-hidden rounded-full bg-secondary ring-2 ring-secondary group-hover:ring-primary/40">
                  {catImg && <Image src={catImg} alt={L(c)} fill sizes="64px" className="object-cover" unoptimized={catImg.startsWith("/api/")} />}
                </div>
                <span className="line-clamp-2 text-xs font-medium leading-tight">{L(c)}</span>
                <span className="text-[10px] text-muted-foreground">{c._count.medicines}</span>
              </Link>
            );
          })}
        </div>
      </Section>

      <Section title={t("home.featured")} href="/shop" viewAll={t("common.viewAll")}>
        <div className={grid}>{featured.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
      </Section>

      {/* Promotion banners */}
      {banners.length > 0 && (
        <section className="mx-auto grid max-w-7xl gap-4 px-4 py-8 md:grid-cols-2">
          {banners.slice(0, 2).map((b) => {
            const bannerImg = safeImageSrc(b.imageUrl);
            const bannerHref = safeNavigationHref(b.link, "/shop");
            const bText = localizeBanner(b, locale, t);
            return (
              <Link key={b.id} href={bannerHref} className="group relative flex min-h-48 items-end overflow-hidden rounded-3xl bg-primary/80 shadow-md">
                {bannerImg && <Image src={bannerImg} alt={bText.title} fill sizes="(max-width:768px) 100vw, 50vw" className="object-cover transition duration-500 group-hover:scale-105" unoptimized={bannerImg.startsWith("/api/")} />}
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />
                <div className="relative p-6 text-white">
                  <h3 className="text-xl font-bold md:text-2xl">{bText.title}</h3>
                  <p className="mt-1 text-sm text-white/85">{bText.subtitle}</p>
                  <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-primary">{t("home.shopNow")} <ArrowRight className="size-4" /></span>
                </div>
              </Link>
            );
          })}
        </section>
      )}

      <Section title={t("home.bestSelling")} href="/shop?sort=popular" viewAll={t("common.viewAll")}>
        <div className={grid}>{best.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
      </Section>

      <div className="mx-auto grid max-w-7xl gap-0 lg:grid-cols-2">
        <Section title={t("home.newProducts")} href="/shop?sort=newest" viewAll={t("common.viewAll")}>
          <div className="grid grid-cols-2 gap-3 sm:gap-4">{newest.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </Section>
        <Section title={t("home.offers")} href="/shop?offers=1" viewAll={t("common.viewAll")}>
          <div className="grid grid-cols-2 gap-3 sm:gap-4">{offers.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </Section>
      </div>
    </>
  );
}
