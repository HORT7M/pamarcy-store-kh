import Image from "next/image";
import credits from "../../../../public/images/CREDITS.json";
import { getT } from "@/lib/i18n/server";
import { safeExternalUrl, safeImageSrc } from "@/lib/sanitize";

export const dynamic = "force-dynamic";
export const metadata = { title: "Photo credits" };

type C = { title: string; source: string; author: string; license: string; licenseUrl: string | null };

export default async function CreditsPage() {
  const { t } = await getT();
  const entries = Object.entries(credits as Record<string, C>);
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-bold">{t("common.photoCredits")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("common.creditsDesc")}</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {entries.map(([file, c]) => {
          const imgSrc = safeImageSrc(`/images/${file}`);
          const sourceHref = safeExternalUrl(c.source, { allowHttp: true });
          const licenseHref = safeExternalUrl(c.licenseUrl, { allowHttp: true });
          const label = c.title.replace(/^File:/, "");
          return (
            <div key={file} className="flex gap-3 rounded-xl border bg-white p-3 text-xs">
              <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                {imgSrc && <Image src={imgSrc} alt={c.title} fill sizes="64px" className="object-cover" />}
              </div>
              <div className="min-w-0">
                {sourceHref ? (
                  <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="line-clamp-1 font-medium text-brand-blue hover:underline">{label}</a>
                ) : (
                  <span className="line-clamp-1 font-medium">{label}</span>
                )}
                <div className="line-clamp-1 text-muted-foreground">{t("common.byAuthor", { author: c.author })}</div>
                <div>{licenseHref ? <a href={licenseHref} target="_blank" rel="noopener noreferrer" className="hover:underline">{c.license}</a> : c.license}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
