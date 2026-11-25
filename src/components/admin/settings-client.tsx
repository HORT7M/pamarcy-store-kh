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
import type { StoreSettings } from "@/lib/settings";
import { api, FetchError } from "@/lib/fetcher";

type NetCfg = { code: "TRC20" | "ERC20" | "BEP20" | "POLYGON"; enabled: boolean; walletAddress: string; contractAddress: string; decimals: number; confirmations: number };
type PaySettingsPayload = {
  methods: { code: "KHQR" | "USDT" | "PAYPAL" | "CASH"; enabled: boolean; online: boolean; pos: boolean; config: Record<string, unknown> }[];
  credentials: { bakongToken: boolean; bakongAccountEnv: string | null; paypal: boolean; paypalEnv: string; paypalWebhook: boolean; tronGridKey: boolean; usdtRpc: Record<string, boolean> };
  networks: Record<string, { label: string; defaultContract: string; defaultDecimals: number; envRpc?: string }>;
};

export function SettingsClient({ canStore, canPayments }: { canStore: boolean; canPayments: boolean }) {
  const router = useRouter();
  const [store, setStore] = useState<StoreSettings | null>(null);
  const [payInfo, setPayInfo] = useState<PaySettingsPayload | null>(null);
  const [khqr, setKhqr] = useState({ enabled: true, online: true, pos: true, merchantName: "Pamarcy Store", merchantCity: "Phnom Penh", accountId: "", merchantType: "individual" as "individual" | "merchant", merchantId: "", acquiringBank: "", mobileNumber: "", currencies: ["USD", "KHR"] as ("USD" | "KHR")[], expiryMinutes: 15 });
  const [usdt, setUsdt] = useState<{ enabled: boolean; online: boolean; pos: boolean; expiryMinutes: number; networks: NetCfg[] }>({ enabled: true, online: true, pos: true, expiryMinutes: 60, networks: [] });
  const [paypal, setPaypal] = useState({ enabled: true, online: true, pos: true, brandName: "Pamarcy Store" });
  const [cash, setCash] = useState({ enabled: true, pos: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (canStore) api<StoreSettings>("/api/admin/settings/store").then(setStore);
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
      });
    }
  }, [canStore, canPayments]);
  useEffect(load, [load]);

  async function saveStore(e: React.FormEvent) {
    e.preventDefault();
    if (!store) return;
    setBusy(true);
    try {
      await api("/api/admin/settings/store", { method: "PUT", body: store });
      toast.success("Store settings saved");
      router.refresh();
    } catch (err) { toast.error((err as Error).message); }
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
      toast.success("Payment settings saved");
      load();
    } catch (err) {
      const fe = err as FetchError;
      if ((fe.details as { code?: string } | undefined)?.code === "CUSTOM_CONTRACT") {
        if (confirm(fe.message)) return savePayments(true);
      } else toast.error(fe.message);
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
      <PageHeader title="System & Payment Settings" subtitle="Configure Cambodia localization, USD/KHR exchange rate, delivery rules and payment providers" />
      <Tabs defaultValue={canStore ? "store" : "payments"}>
        <TabsList className="mb-4">
          {canStore && <TabsTrigger value="store">Store & Localization</TabsTrigger>}
          {canPayments && <TabsTrigger value="payments">Payment Gateways (KHQR · USDT · PayPal)</TabsTrigger>}
        </TabsList>

        {canStore && store && (
          <TabsContent value="store">
            <form onSubmit={saveStore} className="grid gap-6 lg:grid-cols-2">
              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <h2 className="font-semibold">Pharmacy Profile</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>Store Name (English)</Label><Input value={store.storeNameEn} onChange={(e) => setStore({ ...store, storeNameEn: e.target.value })} /></div>
                  <div className="space-y-1"><Label>Store Name (Khmer)</Label><Input value={store.storeNameKm} onChange={(e) => setStore({ ...store, storeNameKm: e.target.value })} /></div>
                  <div className="space-y-1"><Label>Phone (+855)</Label><Input value={store.phone} onChange={(e) => setStore({ ...store, phone: e.target.value })} /></div>
                  <div className="space-y-1"><Label>Email</Label><Input type="email" value={store.email} onChange={(e) => setStore({ ...store, email: e.target.value })} /></div>
                  <div className="space-y-1"><Label>MOH Licence #</Label><Input value={store.licenseNo} onChange={(e) => setStore({ ...store, licenseNo: e.target.value })} /></div>
                  <div className="space-y-1"><Label>Opening Hours</Label><Input value={store.openingHours} onChange={(e) => setStore({ ...store, openingHours: e.target.value })} /></div>
                </div>
                <div className="space-y-1"><Label>Address (English)</Label><Input value={store.addressEn} onChange={(e) => setStore({ ...store, addressEn: e.target.value })} /></div>
                <div className="space-y-1"><Label>Address (Khmer)</Label><Input value={store.addressKm} onChange={(e) => setStore({ ...store, addressKm: e.target.value })} /></div>
              </section>

              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <h2 className="font-semibold">Currency, Delivery & Inventory Rules</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1"><Label>USD / KHR Exchange Rate (៛ per $1)</Label><Input type="number" min={1000} max={10000} value={store.exchangeRate} onChange={(e) => setStore({ ...store, exchangeRate: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>Stock Reservation Window (mins)</Label><Input type="number" min={5} value={store.reservationMinutes} onChange={(e) => setStore({ ...store, reservationMinutes: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>Delivery Fee — Phnom Penh ($)</Label><Input type="number" step="0.01" value={store.deliveryFeePhnomPenh} onChange={(e) => setStore({ ...store, deliveryFeePhnomPenh: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>Delivery Fee — Provinces ($)</Label><Input type="number" step="0.01" value={store.deliveryFeeProvince} onChange={(e) => setStore({ ...store, deliveryFeeProvince: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>Free Delivery Threshold ($)</Label><Input type="number" step="0.01" value={store.freeDeliveryThreshold} onChange={(e) => setStore({ ...store, freeDeliveryThreshold: Number(e.target.value) })} /></div>
                  <div className="space-y-1"><Label>Default Low-Stock Alert</Label><Input type="number" value={store.lowStockDefault} onChange={(e) => setStore({ ...store, lowStockDefault: Number(e.target.value) })} /></div>
                </div>
                <div className="flex items-center justify-between pt-2">
                  <div><div className="text-sm font-medium">Email Notifications</div><div className="text-xs text-muted-foreground">Send alerts via SMTP when configured in .env</div></div>
                  <Switch checked={store.emailNotifications} onCheckedChange={(v) => setStore({ ...store, emailNotifications: v })} />
                </div>
                {store.emailNotifications && <div className="space-y-1"><Label>Notification Recipient Email</Label><Input type="email" value={store.notificationEmail} onChange={(e) => setStore({ ...store, notificationEmail: e.target.value })} /></div>}
                <div className="pt-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save Store Settings</Button></div>
              </section>
            </form>
          </TabsContent>
        )}

        {canPayments && payInfo && (
          <TabsContent value="payments" className="space-y-6">
            <div className="flex items-center gap-2 rounded-xl border bg-white p-3 text-xs text-muted-foreground shadow-xs">
              <ShieldAlert className="size-4 shrink-0 text-primary" /> Private API keys and secrets are read from server environment variables (`.env`) and are never exposed to the browser.
            </div>

            {/* A. KHQR */}
            <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-base font-bold">A. KHQR / Bakong (Cambodia QR)</h2><p className="text-xs text-muted-foreground">Verified exclusively via NBC Bakong Open API (`/v1/check_transaction_by_md5`).</p></div>
                <div className="flex items-center gap-3">
                  <CredBadge ok={payInfo.credentials.bakongToken} label={payInfo.credentials.bakongToken ? "BAKONG_API_TOKEN set" : "BAKONG_API_TOKEN missing"} />
                  <Switch checked={khqr.enabled} onCheckedChange={(v) => setKhqr({ ...khqr, enabled: v })} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1"><Label>Bakong Account ID *</Label><Input value={khqr.accountId} placeholder={payInfo.credentials.bakongAccountEnv ?? "pamarcy@aclb"} onChange={(e) => setKhqr({ ...khqr, accountId: e.target.value })} className="font-mono text-xs" /></div>
                <div className="space-y-1"><Label>Merchant Name (max 25)</Label><Input maxLength={25} value={khqr.merchantName} onChange={(e) => setKhqr({ ...khqr, merchantName: e.target.value })} /></div>
                <div className="space-y-1"><Label>Merchant City (max 15)</Label><Input maxLength={15} value={khqr.merchantCity} onChange={(e) => setKhqr({ ...khqr, merchantCity: e.target.value })} /></div>
                <div className="space-y-1"><Label>QR Expiry (minutes)</Label><Input type="number" min={2} max={60} value={khqr.expiryMinutes} onChange={(e) => setKhqr({ ...khqr, expiryMinutes: Number(e.target.value) })} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-5 text-sm">
                <label className="flex items-center gap-2"><Checkbox checked={khqr.online} onCheckedChange={(v) => setKhqr({ ...khqr, online: !!v })} /> Online checkout</label>
                <label className="flex items-center gap-2"><Checkbox checked={khqr.pos} onCheckedChange={(v) => setKhqr({ ...khqr, pos: !!v })} /> POS</label>
                {(["USD", "KHR"] as const).map((c) => (
                  <label key={c} className="flex items-center gap-2">
                    <Checkbox checked={khqr.currencies.includes(c)} onCheckedChange={(v) => setKhqr({ ...khqr, currencies: v ? [...khqr.currencies, c] : khqr.currencies.filter((x) => x !== c) })} /> Accept {c}
                  </label>
                ))}
              </div>
            </section>

            {/* B. USDT ONLY */}
            <section className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h2 className="text-base font-bold">B. USDT Cryptocurrency (USDT Only)</h2><p className="text-xs text-muted-foreground">Only USDT on administrator-configured networks is accepted. Verifies tx hash, wallet, token contract, network, amount and confirmations.</p></div>
                <div className="flex items-center gap-3">
                  <CredBadge ok={payInfo.credentials.tronGridKey} label={payInfo.credentials.tronGridKey ? "TronGrid Pro key" : "TronGrid public"} />
                  <Switch checked={usdt.enabled} onCheckedChange={(v) => setUsdt({ ...usdt, enabled: v })} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-5 text-sm">
                <label className="flex items-center gap-2"><Checkbox checked={usdt.online} onCheckedChange={(v) => setUsdt({ ...usdt, online: !!v })} /> Online checkout</label>
                <label className="flex items-center gap-2"><Checkbox checked={usdt.pos} onCheckedChange={(v) => setUsdt({ ...usdt, pos: !!v })} /> POS</label>
                <div className="flex items-center gap-2"><Label className="text-xs">Expiration (mins):</Label><Input type="number" min={10} max={1440} value={usdt.expiryMinutes} onChange={(e) => setUsdt({ ...usdt, expiryMinutes: Number(e.target.value) })} className="h-8 w-24" /></div>
              </div>
              <div className="space-y-3">
                {usdt.networks.map((n, idx) => {
                  const meta = payInfo.networks[n.code];
                  const rpcOk = payInfo.credentials.usdtRpc[n.code];
                  const upd = (patch: Partial<NetCfg>) => setUsdt({ ...usdt, networks: usdt.networks.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
                  return (
                    <div key={n.code} className="rounded-xl border p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 font-semibold">{meta.label} <CredBadge ok={rpcOk} label={rpcOk ? "Chain API ready" : `Set ${meta.envRpc} in .env`} /></div>
                        <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Enable {n.code}</span><Switch checked={n.enabled} onCheckedChange={(v) => upd({ enabled: v })} /></div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_90px_110px]">
                        <div className="space-y-1"><Label className="text-xs">Receiving Wallet Address</Label><Input value={n.walletAddress} onChange={(e) => upd({ walletAddress: e.target.value })} placeholder={n.code === "TRC20" ? "T..." : "0x..."} className="font-mono text-xs" /></div>
                        <div className="space-y-1">
                          <div className="flex justify-between"><Label className="text-xs">USDT Token Contract</Label><button type="button" onClick={() => upd({ contractAddress: meta.defaultContract, decimals: meta.defaultDecimals })} className="text-[10px] text-primary hover:underline">Reset official</button></div>
                          <Input value={n.contractAddress} onChange={(e) => upd({ contractAddress: e.target.value })} className="font-mono text-xs" />
                        </div>
                        <div className="space-y-1"><Label className="text-xs">Decimals</Label><Input type="number" value={n.decimals} onChange={(e) => upd({ decimals: Number(e.target.value) })} /></div>
                        <div className="space-y-1"><Label className="text-xs">Confirmations</Label><Input type="number" min={1} value={n.confirmations} onChange={(e) => upd({ confirmations: Number(e.target.value) })} /></div>
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
                  <div><h2 className="text-base font-bold">C. PayPal Checkout ({payInfo.credentials.paypalEnv.toUpperCase()})</h2><p className="text-xs text-muted-foreground">Orders v2 server-side create & capture + webhook verification.</p></div>
                  <Switch checked={paypal.enabled} onCheckedChange={(v) => setPaypal({ ...paypal, enabled: v })} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <CredBadge ok={payInfo.credentials.paypal} label={payInfo.credentials.paypal ? "Client ID & Secret set" : "PAYPAL credentials missing"} />
                  <CredBadge ok={payInfo.credentials.paypalWebhook} label={payInfo.credentials.paypalWebhook ? "Webhook ID set" : "PAYPAL_WEBHOOK_ID optional"} />
                </div>
                <div className="space-y-1"><Label>Checkout Brand Name</Label><Input value={paypal.brandName} onChange={(e) => setPaypal({ ...paypal, brandName: e.target.value })} /></div>
                <div className="flex gap-5 text-sm">
                  <label className="flex items-center gap-2"><Checkbox checked={paypal.online} onCheckedChange={(v) => setPaypal({ ...paypal, online: !!v })} /> Online checkout</label>
                  <label className="flex items-center gap-2"><Checkbox checked={paypal.pos} onCheckedChange={(v) => setPaypal({ ...paypal, pos: !!v })} /> POS</label>
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div><h2 className="text-base font-bold">POS Counter Cash</h2><p className="text-xs text-muted-foreground">Walk-in counter sales verified by cashier receiving cash.</p></div>
                  <Switch checked={cash.enabled} onCheckedChange={(v) => setCash({ ...cash, enabled: v })} />
                </div>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={cash.pos} onCheckedChange={(v) => setCash({ ...cash, pos: !!v })} /> Enable Cash at POS</label>
              </section>
            </div>

            <div className="flex justify-end"><Button size="lg" onClick={() => savePayments(false)} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save Payment Configuration</Button></div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
