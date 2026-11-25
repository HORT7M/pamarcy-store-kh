"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, Upload, FileCheck2, AlertTriangle, ShoppingBag, MapPin } from "lucide-react";
import { toast } from "sonner";
import { useCart } from "@/components/providers/cart-provider";
import { useI18n } from "@/components/providers/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { ProductImage } from "@/components/common/product-image";
import { AddressFields, type AddressValue } from "@/components/common/address-fields";
import { BotProtectionWidget, HoneypotField, useBotProtection } from "@/components/security/bot-protection";
import { useQuote } from "./use-quote";
import { OrderSummary } from "./order-summary";
import { api, FetchError } from "@/lib/fetcher";
import { isKhPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

type Addr = { id: string; label: string | null; fullName: string; phone: string; province: string; district: string; commune: string | null; village: string | null; street: string | null; instructions: string | null; isDefault: boolean };

export function CheckoutForm({ user, addresses }: { user: { name: string; email: string; phone: string | null } | null; addresses: Addr[] }) {
  const { items, ready, discountCode, clear } = useCart();
  const { t, pick, money } = useI18n();
  const router = useRouter();
  const def = addresses.find((a) => a.isDefault) ?? addresses[0];
  const [selected, setSelected] = useState<string | null>(def?.id ?? null);
  const [fullName, setFullName] = useState(def?.fullName ?? user?.name ?? "");
  const [phone, setPhone] = useState(def?.phone ?? user?.phone ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [addr, setAddr] = useState<AddressValue>({ province: def?.province ?? "", district: def?.district ?? "", commune: def?.commune ?? "", village: def?.village ?? "", street: def?.street ?? "" });
  const [instructions, setInstructions] = useState(def?.instructions ?? "");
  const [saveAddress, setSaveAddress] = useState(!!user && addresses.length === 0);
  const [agree, setAgree] = useState(false);
  const [rxUrl, setRxUrl] = useState<string | null>(null);
  const [pendingRxFile, setPendingRxFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { quote, loading, error } = useQuote(items, discountCode, addr.province || null, ready);

  const checkoutBot = useBotProtection("checkout", { autoLoad: !user });
  const uploadBot = useBotProtection("prescription_upload", { autoLoad: false });

  useEffect(() => {
    if (!selected) return;
    const a = addresses.find((x) => x.id === selected);
    if (!a) return;
    setFullName(a.fullName); setPhone(a.phone); setInstructions(a.instructions ?? "");
    setAddr({ province: a.province, district: a.district, commune: a.commune ?? "", village: a.village ?? "", street: a.street ?? "" });
  }, [selected, addresses]);

  async function upload(file: File, useCurrentUploadBot = false) {
    if (file.size > 5 * 1024 * 1024) return toast.error("Max 5 MB");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder", "prescriptions");
      if (!user) {
        if (useCurrentUploadBot) {
          uploadBot.appendToFormData(fd);
        } else {
          const payload = await uploadBot.ensurePayload();
          if (uploadBot.visible && !payload.answer && uploadBot.challenge?.provider === "builtin" && uploadBot.challenge.mode !== "silent") {
            setPendingRxFile(file);
            toast.info(t("security.required"));
            return;
          }
          uploadBot.appendToFormData(fd, payload);
        }
      }
      const r = await api<{ url: string }>("/api/uploads", { method: "POST", body: fd });
      setRxUrl(r.url);
      setPendingRxFile(null);
      toast.success(t("checkout.uploaded"));
    } catch (e) {
      const fe = e as FetchError;
      if (uploadBot.handleError(fe)) {
        setPendingRxFile(file);
      }
      toast.error(fe.message);
    } finally {
      setUploading(false);
    }
  }

  function validate() {
    const e: Record<string, string> = {};
    if (fullName.trim().length < 2) e.fullName = t("common.required");
    if (!isKhPhone(phone)) e.phone = t("checkout.invalidPhone");
    if (email && !/^\S+@\S+\.\S+$/.test(email)) e.email = "Invalid email";
    if (!addr.province) e.province = t("common.required");
    if (!addr.district) e.district = t("common.required");
    if (quote?.requiresPrescription && !rxUrl) e.rx = t("checkout.prescriptionHelp");
    if (!agree) e.agree = t("common.required");
    if (checkoutBot.visible && !checkoutBot.ready) e.bot = t("security.required");
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return toast.error(t("common.error"), { description: Object.values(errors)[0] });
    setSubmitting(true);
    try {
      const r = await api<{ id: string; token: string }>("/api/orders", {
        method: "POST",
        body: {
          items: items.map((i) => ({ medicineId: i.medicineId, quantity: i.quantity })),
          discountCode: discountCode || null,
          fullName,
          phone,
          email: email || null,
          ...addr,
          instructions,
          prescriptionUrl: rxUrl,
          saveAddress,
          _bot: checkoutBot.getPayload(),
        },
      });
      clear();
      router.push(`/checkout/pay/${encodeURIComponent(r.id)}?token=${encodeURIComponent(r.token)}`);
    } catch (e) {
      const fe = e as FetchError;
      checkoutBot.handleError(fe, phone);
      toast.error(fe.message);
      setSubmitting(false);
    }
  }

  if (!ready) return <div className="mx-auto max-w-7xl space-y-3 px-4 py-8"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  if (!items.length) return <div className="mx-auto max-w-3xl px-4 py-12"><EmptyState icon={ShoppingBag} title={t("cart.empty")} action={<Button asChild className="rounded-full"><Link href="/shop">{t("cart.continue")}</Link></Button>} /></div>;

  const field = (id: string, label: string, el: React.ReactNode, err?: string) => (
    <div className="space-y-1.5"><Label htmlFor={id}>{label}</Label>{el}{err && <p className="text-xs text-red-600">{err}</p>}</div>
  );

  return (
    <form onSubmit={submit} className="mx-auto max-w-7xl px-4 py-8" noValidate>
      <HoneypotField value={checkoutBot.hp} onChange={checkoutBot.setHp} />
      <h1 className="mb-6 text-2xl font-bold">{t("checkout.title")}</h1>
      {!user && <p className="mb-4 rounded-xl bg-accent p-3 text-sm text-accent-foreground"><Link href="/login?next=/checkout" className="font-semibold underline">{t("common.login")}</Link> — {t("checkout.loginPrompt")}</p>}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("checkout.contact")}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {field("fullName", `${t("checkout.fullName")} *`, <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} aria-invalid={!!errors.fullName} autoComplete="name" />, errors.fullName)}
              {field("phone", `${t("checkout.phone")} *`, <Input id="phone" type="tel" inputMode="tel" placeholder="012 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!errors.phone} autoComplete="tel" />, errors.phone)}
              <div className="sm:col-span-2">{field("email", t("checkout.email"), <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} autoComplete="email" />, errors.email)}</div>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{t("checkout.delivery")}</h2>
            {addresses.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {addresses.map((a) => (
                  <button type="button" key={a.id} onClick={() => setSelected(a.id)} className={cn("rounded-xl border p-3 text-left text-sm transition", selected === a.id ? "border-primary bg-secondary ring-2 ring-primary/20" : "hover:border-primary/50")}>
                    <div className="flex items-center gap-1.5 font-medium"><MapPin className="size-3.5 text-primary" /> {a.label ?? a.fullName}</div>
                    <div className="text-xs text-muted-foreground">{[a.street, a.district, a.province].filter(Boolean).join(", ")}</div>
                  </button>
                ))}
                <button type="button" onClick={() => { setSelected(null); setAddr({ province: "", district: "", commune: "", village: "", street: "" }); }} className={cn("rounded-xl border border-dashed p-3 text-sm text-muted-foreground", !selected && "border-primary text-primary")}>+ {t("account.addAddress")}</button>
              </div>
            )}
            <AddressFields value={addr} onChange={(v) => { setAddr(v); setSelected(null); }} errors={errors} />
            {field("instructions", t("checkout.instructions"), <Textarea id="instructions" value={instructions} maxLength={500} onChange={(e) => setInstructions(e.target.value)} placeholder={t("checkout.instructionsPh")} rows={2} />)}
            {user && !selected && <label className="flex items-center gap-2 text-sm"><Checkbox checked={saveAddress} onCheckedChange={(v) => setSaveAddress(!!v)} /> {t("common.save")} — {t("account.addresses")}</label>}
          </section>

          {quote?.requiresPrescription && (
            <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle className="size-5" /> {t("checkout.prescription")}</h2>
              <p className="text-sm text-amber-900">{t("product.rxWarning")}</p>
              <p className="text-xs text-amber-800">{t("checkout.prescriptionHelp")}</p>
              <label className={cn("flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-white p-5 text-sm font-medium", rxUrl ? "border-primary text-primary" : "border-amber-300 text-amber-800", errors.rx && !rxUrl && "border-red-400")}>
                {uploading ? <Loader2 className="size-5 animate-spin" /> : rxUrl ? <FileCheck2 className="size-5" /> : <Upload className="size-5" />}
                {rxUrl ? t("checkout.uploaded") : pendingRxFile ? pendingRxFile.name : t("checkout.uploadRx")}
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} disabled={uploading} />
              </label>
              {!user && uploadBot.visible && (uploadBot.challenge?.provider !== "builtin" || uploadBot.challenge.mode !== "silent") && (
                <div className="space-y-2">
                  <BotProtectionWidget bot={uploadBot} compact />
                  {pendingRxFile && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={uploading || !uploadBot.ready}
                      onClick={() => pendingRxFile && void upload(pendingRxFile, true)}
                    >
                      {uploading && <Loader2 className="animate-spin" />}
                      {t("checkout.uploadRx")}
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-36 lg:h-fit">
          <div className="space-y-3 rounded-2xl border bg-white p-4 shadow-sm">
            {items.map((i) => (
              <div key={i.medicineId} className="flex items-center gap-3 text-sm">
                <div className="relative"><ProductImage src={i.imageUrl} alt={i.nameEn} className="size-12 rounded-lg" sizes="48px" /><span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-[10px] text-white">{i.quantity}</span></div>
                <span className="line-clamp-2 flex-1">{pick(i, "name")}</span>
                <span className="font-medium">{money(i.price * i.quantity)}</span>
              </div>
            ))}
          </div>
          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <OrderSummary quote={quote} loading={loading} deliveryKnown={!!addr.province}>
            <BotProtectionWidget bot={checkoutBot} compact />
            {errors.bot && <p className="text-xs text-red-600">{errors.bot}</p>}
            <label className="flex items-start gap-2 text-xs text-muted-foreground"><Checkbox checked={agree} onCheckedChange={(v) => setAgree(!!v)} className="mt-0.5" aria-invalid={!!errors.agree} /> {t("checkout.agree")}</label>
            <Button type="submit" size="lg" className="w-full rounded-full" disabled={submitting || loading || !quote?.stockOk || uploading || (checkoutBot.visible && checkoutBot.solving)}>
              {submitting ? <><Loader2 className="animate-spin" /> {t("checkout.placing")}</> : t("checkout.placeOrder")}
            </Button>
            {quote && !quote.stockOk && <p className="text-center text-xs text-red-600"><Link href="/cart" className="underline">{t("cart.title")}</Link> — {t("common.outOfStock")}</p>}
          </OrderSummary>
        </div>
      </div>
    </form>
  );
}
