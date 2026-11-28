"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "./common";
import { useI18n } from "@/components/providers/i18n-provider";
import type { StoreSettings } from "@/lib/settings";
import { api, FetchError } from "@/lib/fetcher";

type NetCfg = { code: "TRC20" | "ERC20" | "BEP20" | "POLYGON"; enabled: boolean; walletAddress: string; contractAddress: string; decimals: number; confirmations: number };
type PaySettingsPayload = {
  methods: { code: "KHQR" | "USDT" | "PAYPAL" | "CASH"; enabled: boolean; online: boolean; pos: boolean; config: Record<string, unknown> }[];
  credentials: { bakongToken: boolean; bakongAccountEnv: string | null; paypal: boolean; paypalEnv: string; paypalWebhook: boolean; tronGridKey: boolean; usdtRpc: Record<string, boolean> };
  networks: Record<string, { label: string; defaultContract: string; defaultDecimals: number; envRpc?: string }>;
};

export function SettingsClient({ canStore, canPayments }: { canStore: boolean; canPayments: boolean }) {
  const { t, tError } = useI18n();
  const router = useRouter();
  const [store, setStore] = useState<StoreSettings | null>(null);
  const [payInfo, setPayInfo] = useState<PaySettingsPayload | null>(null);
  const [khqr, setKhqr] = useState({ enabled: true, online: true, pos: true, merchantName: "Pamarcy Store", merchantCity: "Phnom Penh", accountId: "", merchantType: "individual" as "individual" | "merchant", merchantId: "", acquiringBank: "", mobileNumber: "", currencies: ["USD", "KHR"] as ("USD" | "KHR")[], expiryMinutes: 15 });
  const [usdt, setUsdt] = useState<{ enabled: boolean; online: boolean; pos: boolean; expiryMinutes: number; networks: NetCfg[] }>({ enabled: true, online: true, pos: true, expiryMinutes: 60, networks: [] });
  const [paypal, setPaypal] = useState({ enabled: true, online: true, pos: true, brandName: "Pamarcy Store" });
  const [cash, setCash] = useState({ enabled: true, pos: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (canStore) api<StoreSettings>("/api/admin/settings/store").then(setStore).catch((e) => toast.error(tError((e as Error).message)));
    if (canPayments) {
      api<PaySettingsPayload>("/api/admin/settings/payments").then((d) => {
        setPayInfo(d);
        const k = d.methods.find((m) => m.code === "KHQR");
        if (k) {
          const kc = k.config as Partial<typeof khqr>;
          setKhqr({ enabled: k.enabled, online: k.online, pos: k.pos, merchantName: kc.merchantName ?? "Pamarcy Store", merchantCity: kc.merchantCity ?? "Phnom Penh", accountId: kc.accountId ?? "", merchantType: kc.merchantType ?? "individual", merchantId: kc.merchantId ?? "", acquiringBank: kc.acquiringBank ?? "", mobileNumber: kc.mobileNumber ?? "", currencies: kc.currencies ?? ["USD", "KHR"], expiryMinutes: kc.expiryMinutes ?? 15 });
        }
        const u = d.methods.find((m) => m.code === "USDT");
        if (u) {
          const uc = u.config as { expiryMinutes?: number; networks?: NetCfg[] };
          setUsdt({ enabled: u.enabled, online: u.online, pos: u.pos, expiryMinutes: uc.expiryMinutes ?? 60, networks: uc.networks ?? [] });
        }
        const p = d.methods.find((m) => m.code === "PAYPAL");
        if (p) setPaypal({ enabled: p.enabled, online: p.online, pos: p.pos, brandName: (p.config as { brandName?: string }).brandName ?? "Pamarcy Store" });
        const c = d.methods.find((m) => m.code === "CASH");
        if (c) setCash({ enabled: c.enabled, pos: c.pos });
      }).catch((e) => toast.error(tError((e as Error).message)));
    }
  }, [canStore, canPayments, tError]);
  useEffect(load, [load]);

  async function saveStore(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    setBusy(true);
    try {
      await api("/api/admin/settings/store", { method: "PUT", body: store });
      toast.success(t("settingsAdmin.storeSavedToast"));
      router.refresh();
    } catch (err) { toast.error(tError((err as Error).message)); }
    finally { setBusy(false); }
  }

  async function savePayments(confirmCustom = false) {
    setBusy(true);
    const body = {
      KHQR: { enabled: khqr.enabled, online: khqr.online, pos: khqr.pos, config: { merchantName: khqr.merchantName, merchantCity: khqr.merchantCity, accountId: khqr.accountId, merchantType: khqr.merchantType, merchantId: khqr.merchantId, acquiringBank: khqr.acquiringBank, mobileNumber: khqr.mobileNumber, currencies: khqr.currencies, expiryMinutes: Number(khqr.expiryMinutes) } },
      USDT: { enabled: usdt.enabled, online: usdt.online, pos: usdt.pos, config: { expiryMinutes: Number(usdt.expiryMinutes), networks: usdt.networks } },
      PAYPAL: { enabled: paypal.enabled, online: paypal.online, pos: paypal.pos, config: { brandName: paypal.brandName } },
      CASH: { enabled: cash.enabled, online: false as const, pos: cash.pos, config: {} },
    };
    try {
      await api("/api/admin/settings/payments", { method: "PUT", body, headers: confirmCustom ? { "x-confirm-custom-contract": "1" } : undefined });
      toast.success(t("settingsAdmin.paymentsSavedToast"));
      load();
    } catch (err) {
      const fe = err as FetchError;
      if ((fe.details as { code?: string } | undefined)?.code === "CUSTOM_CONTRACT") {
        if (confirm(fe.message)) return savePayments(true);
      } else toast.error(tError(fe.message));
    } finally {
      setBusy(false);
    }
  }

  const CredBadge = ({ ok, label }: { ok: boolean; label: string }) => (
    <Badge variant="outline" className={ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}>
      {ok ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />} {label}
    </Badge>
  );

  return (
    <div>
      <PageHeader title={t("settingsAdmin.title")} subtitle={t("settingsAdmin.subtitle")} />
      <Tabs defaultValue={canStore ? "store" : "payments"}>
        <TabsList className="mb-4">
          {canStore && <TabsTrigger value="store">{t("settingsAdmin.tabStore")}</TabsTrigger>}
          {canPayments && <TabsTrigger value="payments">{t("settingsAdmin.tabPayments")}</TabsTrigger>}
        </TabsList>

        {canStore && store && (
          <TabsContent value="store">
            <form onSubmit={saveStore} className="grid gap-6 lg:grid-cols-2">
              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <h2 className="font-semibold">{t("settingsAdmin.pharmacyProfile")}</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>{t("settingsAdmin.storeNameEn")}</Label><Input value={store.storeNameEn} onChange={(e) => setStore({ ...store, storeNameEn: e.target.value })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.storeNameKm")}</Label><Input value={store.storeNameKm} onChange={(e) => setStore({ ...store, storeNameKm: e.target.value })} /></div>
                  <div className="space-y-1"><Label>{t("checkout.phone")}</Label><Input value={store.phone} onChange={(e) => setStore({ ...store, phone: e.target.value })} /></div>
                  <div className="space-y-1"><Label>{t("common.email")}</Label><Input type="email" value={store.email} onChange={(e) => setStore({ ...store, email: e.target.value })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.mohLicenceNo")}</Label><Input value={store.licenseNo} onChange={(e) => setStore({ ...store, licenseNo: e.target.value })} /></div>
                  <div className="space-y-1"><Label>{t("common.openingHours")}</Label><Input value={store.openingHours} onChange={(e) => setStore({ ...store, openingHours: e.target.value })} /></div>
                </div>
                <div className="space-y-1"><Label>{t("settingsAdmin.addressEn")}</Label><Input value={store.addressEn} onChange={(e) => setStore({ ...store, addressEn: e.target.value })} /></div>
                <div className="space-y-1"><Label>{t("settingsAdmin.addressKm")}</Label><Input value={store.addressKm} onChange={(e) => setStore({ ...store, addressKm: e.target.value })} /></div>
              </section>

              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <h2 className="font-semibold">{t("settingsAdmin.currencyDeliveryRules")}</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>{t("settingsAdmin.exchangeRateLabel")}</Label><Input type="number" min={1000} max={10000} value={store.exchangeRate} onChange={(e) => setStore({ ...store, exchangeRate: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.reservationWindowLabel")}</Label><Input type="number" min={5} value={store.reservationMinutes} onChange={(e) => setStore({ ...store, reservationMinutes: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.deliveryPhnomPenh")}</Label><Input type="number" step="0.01" value={store.deliveryFeePhnomPenh} onChange={(e) => setStore({ ...store, deliveryFeePhnomPenh: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.deliveryProvinces")}</Label><Input type="number" step="0.01" value={store.deliveryFeeProvince} onChange={(e) => setStore({ ...store, deliveryFeeProvince: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.freeDeliveryThreshold")}</Label><Input type="number" step="0.01" value={store.freeDeliveryThreshold} onChange={(e) => setStore({ ...store, freeDeliveryThreshold: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>{t("settingsAdmin.lowStockDefault")}</Label><Input type="number" value={store.lowStockDefault} onChange={(e) => setStore({ ...store, lowStockDefault: Number(e.target.value) })} /></div>
                </div>
                <div className="flex items-center justify-between pt-2">
                  <div><div className="text-sm font-medium">{t("settingsAdmin.emailNotifications")}</div><div className="text-xs text-muted-foreground">{t("settingsAdmin.emailNotificationsSub")}</div></div>
                  <Switch checked={store.emailNotifications} onCheckedChange={(v) => setStore({ ...store, emailNotifications: v })} />
                </div>
                {store.emailNotifications && <div className="space-y-1"><Label>{t("settingsAdmin.notificationRecipient")}</Label><Input type="email" value={store.notificationEmail} onChange={(e) => setStore({ ...store, notificationEmail: e.target.value })} /></div>}
                <div className="pt-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("settingsAdmin.saveStoreBtn")}</Button></div>
              </section>
            </form>
          </TabsContent>
        )}

        {canPayments && payInfo && (
          <TabsContent value="payments" className="space-y-6">
            <div className="flex items-center gap-2 rounded-xl border bg-white p-3 text-xs text-muted-foreground shadow-xs">
              <ShieldAlert className="size-4 shrink-0 text-primary" /> {t("settingsAdmin.envSecurityNotice")}
            </div>

            {/* A. KHQR */}
            <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-base font-bold">{t("settingsAdmin.khqrTitle")}</h2><p className="text-xs text-muted-foreground">{t("settingsAdmin.khqrSub")}</p></div>
                <div className="flex items-center gap-3">
                  <CredBadge ok={payInfo.credentials.bakongToken} label={payInfo.credentials.bakongToken ? t("settingsAdmin.bakongTokenSet") : t("settingsAdmin.bakongTokenMissing")} />
                  <Switch checked={khqr.enabled} onCheckedChange={(v) => setKhqr({ ...khqr, enabled: v })} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1"><Label>{t("settingsAdmin.bakongAccountId")} *</Label><Input value={khqr.accountId} placeholder={payInfo.credentials.bakongAccountEnv ?? "pamarcy@aclb"} onChange={(e) => setKhqr({ ...khqr, accountId: e.target.value })} className="font-mono text-xs" /></div>
                <div className="space-y-1"><Label>{t("settingsAdmin.merchantName")}</Label><Input maxLength={25} value={khqr.merchantName} onChange={(e) => setKhqr({ ...khqr, merchantName: e.target.value })} /></div>
                <div className="space-y-1"><Label>{t("settingsAdmin.merchantCity")}</Label><Input maxLength={15} value={khqr.merchantCity} onChange={(e) => setKhqr({ ...khqr, merchantCity: e.target.value })} /></div>
                <div className="space-y-1"><Label>{t("settingsAdmin.qrExpiryMins")}</Label><Input type="number" min={2} max={60} value={khqr.expiryMinutes} onChange={(e) => setKhqr({ ...khqr, expiryMinutes: Number(e.target.value) })} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-5 text-sm">
                <label className="flex items-center gap-2"><Checkbox checked={khqr.online} onCheckedChange={(v) => setKhqr({ ...khqr, online: !!v })} /> {t("settingsAdmin.onlineCheckout")}</label>
                <label className="flex items-center gap-2"><Checkbox checked={khqr.pos} onCheckedChange={(v) => setKhqr({ ...khqr, pos: !!v })} /> {t("settingsAdmin.posChannel")}</label>
                {(["USD", "KHR"] as const).map((c) => (
                  <label key={c} className="flex items-center gap-2">
                    <Checkbox checked={khqr.currencies.includes(c)} onCheckedChange={(v) => setKhqr({ ...khqr, currencies: v ? Array.from(new Set([...khqr.currencies, c])) : khqr.currencies.filter((x) => x !== c) })} /> {t("settingsAdmin.acceptCurrency", { currency: c })}
                  </label>
                ))}
              </div>
            </section>

            {/* B. USDT ONLY */}
            <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-base font-bold">{t("settingsAdmin.usdtTitle")}</h2><p className="text-xs text-muted-foreground">{t("settingsAdmin.usdtSub")}</p></div>
                <div className="flex items-center gap-3">
                  <CredBadge ok={payInfo.credentials.tronGridKey} label={payInfo.credentials.tronGridKey ? t("settingsAdmin.tronGridPro") : t("settingsAdmin.tronGridPublic")} />
                  <Switch checked={usdt.enabled} onCheckedChange={(v) => setUsdt({ ...usdt, enabled: v })} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-5 text-sm">
                <label className="flex items-center gap-2"><Checkbox checked={usdt.online} onCheckedChange={(v) => setUsdt({ ...usdt, online: !!v })} /> {t("settingsAdmin.onlineCheckout")}</label>
                <label className="flex items-center gap-2"><Checkbox checked={usdt.pos} onCheckedChange={(v) => setUsdt({ ...usdt, pos: !!v })} /> {t("settingsAdmin.posChannel")}</label>
                <div className="flex items-center gap-2"><Label className="text-xs">{t("settingsAdmin.expirationMins")}</Label><Input type="number" min={10} max={1440} value={usdt.expiryMinutes} onChange={(e) => setUsdt({ ...usdt, expiryMinutes: Number(e.target.value) })} className="h-8 w-24" /></div>
              </div>
              <div className="space-y-3">
                {usdt.networks.map((n, idx) => {
                  const meta = payInfo.networks[n.code];
                  const rpcOk = payInfo.credentials.usdtRpc[n.code];
                  const upd = (patch: Partial<NetCfg>) => setUsdt({ ...usdt, networks: usdt.networks.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
                  return (
                    <div key={n.code} className="rounded-xl border p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-semibold">{meta.label} <CredBadge ok={rpcOk} label={rpcOk ? t("settingsAdmin.chainApiReady") : t("settingsAdmin.setEnvInFile", { env: meta.envRpc ?? "" })} /></div>
                        <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{t("settingsAdmin.enableNetwork", { code: n.code })}</span><Switch checked={n.enabled} onCheckedChange={(v) => upd({ enabled: v })} /></div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_90px_110px]">
                        <div className="space-y-1"><Label className="text-xs">{t("settingsAdmin.receivingWallet")}</Label><Input value={n.walletAddress} onChange={(e) => upd({ walletAddress: e.target.value })} placeholder={n.code === "TRC20" ? "T..." : "0x..."} className="font-mono text-xs" /></div>
                        <div className="space-y-1">
                          <div className="flex justify-between"><Label className="text-xs">{t("settingsAdmin.usdtContract")}</Label><button type="button" onClick={() => upd({ contractAddress: meta.defaultContract, decimals: meta.defaultDecimals })} className="text-[10px] text-primary hover:underline">{t("settingsAdmin.resetOfficial")}</button></div>
                          <Input value={n.contractAddress} onChange={(e) => upd({ contractAddress: e.target.value })} className="font-mono text-xs" />
                        </div>
                        <div className="space-y-1"><Label className="text-xs">{t("settingsAdmin.decimals")}</Label><Input type="number" value={n.decimals} onChange={(e) => upd({ decimals: Number(e.target.value) })} /></div>
                        <div className="space-y-1"><Label className="text-xs">{t("settingsAdmin.confirmations")}</Label><Input type="number" min={1} value={n.confirmations} onChange={(e) => upd({ confirmations: Number(e.target.value) })} /></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* C. PayPal & Cash */}
            <div className="grid gap-6 lg:grid-cols-2">
              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div><h2 className="text-base font-bold">{t("settingsAdmin.paypalTitle", { env: payInfo.credentials.paypalEnv.toUpperCase() })}</h2><p className="text-xs text-muted-foreground">{t("settingsAdmin.paypalSub")}</p></div>
                  <Switch checked={paypal.enabled} onCheckedChange={(v) => setPaypal({ ...paypal, enabled: v })} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <CredBadge ok={payInfo.credentials.paypal} label={payInfo.credentials.paypal ? t("settingsAdmin.paypalCredsSet") : t("settingsAdmin.paypalCredsMissing")} />
                  <CredBadge ok={payInfo.credentials.paypalWebhook} label={payInfo.credentials.paypalWebhook ? t("settingsAdmin.webhookSet") : t("settingsAdmin.webhookOptional")} />
                </div>
                <div className="space-y-1"><Label>{t("settingsAdmin.checkoutBrandName")}</Label><Input value={paypal.brandName} onChange={(e) => setPaypal({ ...paypal, brandName: e.target.value })} /></div>
                <div className="flex gap-5 text-sm">
                  <label className="flex items-center gap-2"><Checkbox checked={paypal.online} onCheckedChange={(v) => setPaypal({ ...paypal, online: !!v })} /> {t("settingsAdmin.onlineCheckout")}</label>
                  <label className="flex items-center gap-2"><Checkbox checked={paypal.pos} onCheckedChange={(v) => setPaypal({ ...paypal, pos: !!v })} /> {t("settingsAdmin.posChannel")}</label>
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div><h2 className="text-base font-bold">{t("settingsAdmin.posCashTitle")}</h2><p className="text-xs text-muted-foreground">{t("settingsAdmin.posCashSub")}</p></div>
                  <Switch checked={cash.enabled} onCheckedChange={(v) => setCash({ ...cash, enabled: v })} />
                </div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={cash.pos} onCheckedChange={(v) => setCash({ ...cash, pos: !!v })} /> {t("settingsAdmin.enableCashPos")}</label>
              </section>
            </div>

            <div className="flex justify-end"><Button size="lg" onClick={() => savePayments(false)} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {t("settingsAdmin.savePaymentsBtn")}</Button></div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
