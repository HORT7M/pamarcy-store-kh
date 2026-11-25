import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({ href = "/", className, subtitle, light }: { href?: string; className?: string; subtitle?: string; light?: boolean }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5 shrink-0", className)} aria-label="Pamarcy Store">
      <svg viewBox="0 0 64 64" className="size-9 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="16" fill="#0f9d58" />
        <path d="M26 14h12v12h12v12H38v12H26V38H14V26h12z" fill="#fff" />
        <circle cx="47" cy="47" r="9" fill="#2563eb" stroke="#fff" strokeWidth="3" />
        <path d="M43 47h8" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="leading-tight">
        <span className={cn("block text-lg font-bold tracking-tight", light ? "text-white" : "text-foreground")}>
          Pamarcy<span className="text-primary">Store</span>
        </span>
        {subtitle && <span className={cn("block text-[11px]", light ? "text-white/70" : "text-muted-foreground")}>{subtitle}</span>}
      </span>
    </Link>
  );
}
