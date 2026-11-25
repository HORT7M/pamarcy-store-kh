"use client";

import Link from "next/link";
import { useState } from "react";
import {
  DollarSign, TrendingUp, ShoppingBag, Clock, CheckCircle2, Users, Pill,
  AlertTriangle, CalendarX2, CalendarClock, CreditCard, ArrowRight,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { useI18n } from "@/components/providers/i18n-provider";
import { PageHeader, StatCard } from "./common";
import { StatusBadge } from "@/components/common/status-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/date";

type SeriesPoint = { key: string; label: string; revenue: number; orders: number; cost: number; profit: number };
type DashData = {
  totals: {
    totalSales: number; todaySales: number; todayOrders: number; monthRevenue: number; monthProfit: number;
    totalOrders: number; pendingOrders: number; completedOrders: number; customers: number; medicines: number;
    lowStock: number; outOfStock: number; expiredBatches: number; expiringSoon: number;
  };
  stock: { total: number; low: number; out: number; healthy: number; expiredBatches: number; expiringSoon: number; costValue: number; retailValue: number };
  daily: SeriesPoint[];
  monthly: SeriesPoint[];
  yearly: SeriesPoint[];
  top: { medicineId: string; nameEn: string; nameKm: string; sku: string; qty: number; revenue: number; cost: number }[];
  payments: { method: string; paid: number; count: number; failed: number; pending: number }[];
  recent: { id: string; number: string; fullName: string; total: string; status: string; paymentStatus: string; channel: string; createdAt: string }[];
};

const PAY_COLORS = ["#0f9d58", "#2563eb", "#f59e0b", "#8b5cf6", "#ef4444"];
const STOCK_COLORS = ["#0f9d58", "#f59e0b", "#ef4444"];

export function DashboardClient({ data }: { data: DashData }) {
  const { locale, money, t, tryT } = useI18n();
  const km = locale === "km";
  const [period, setPeriod] = useState<"daily" | "monthly" | "yearly">("daily");
  const tot = data.totals;
  const series = period === "daily" ? data.daily : period === "monthly" ? data.monthly : data.yearly;
  const stockPie = [
    { name: t("dashboard.healthy"), value: data.stock.healthy },
    { name: t("dashboard.lowStock"), value: data.stock.low },
    { name: t("dashboard.outOfStock"), value: data.stock.out },
  ];
  const topData = data.top.map((m) => ({ ...m, short: (km ? m.nameKm : m.nameEn).slice(0, 22) }));
  const paymentChartData = data.payments
    .filter((p) => p.paid > 0)
    .map((p) => ({ ...p, methodLabel: tryT(`catalogData.paymentMethods.${p.method}`, p.method) }));
  const totalPaidCount = data.payments.reduce((s, p) => s + p.count, 0);
  const totalPaidUsd = data.payments.reduce((s, p) => s + p.paid, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        actions={
          <>
            <Button asChild variant="outline"><Link href="/admin/reports">{t("adminNav.links.reports")}</Link></Button>
            <Button asChild><Link href="/admin/pos">{t("dashboard.openPos")}</Link></Button>
          </>
        }
      />

      {/* Primary KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={DollarSign} tone="green" label={t("dashboard.totalSales")} value={money(tot.totalSales)} sub={t("dashboard.completedSub", { n: tot.completedOrders })} />
        <StatCard icon={TrendingUp} tone="blue" label={t("dashboard.todaySales")} value={money(tot.todaySales)} sub={t("dashboard.ordersTodaySub", { n: tot.todayOrders })} />
        <StatCard icon={DollarSign} tone="green" label={t("dashboard.monthlyRevenue")} value={money(tot.monthRevenue)} sub={`${t("dashboard.grossProfit")}: ${money(tot.monthProfit)}`} />
        <StatCard icon={CreditCard} tone="blue" label={t("dashboard.payments90d")} value={money(totalPaidUsd)} sub={t("dashboard.settledSub", { n: totalPaidCount })} />
      </div>

      {/* Operational KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatCard icon={ShoppingBag} tone="slate" label={t("dashboard.totalOrders")} value={tot.totalOrders} />
        <StatCard icon={Clock} tone="amber" label={t("dashboard.pendingOrders")} value={tot.pendingOrders} />
        <StatCard icon={CheckCircle2} tone="green" label={t("dashboard.completed")} value={tot.completedOrders} />
        <StatCard icon={Users} tone="blue" label={t("dashboard.customers")} value={tot.customers} />
        <StatCard icon={Pill} tone="green" label={t("dashboard.medicines")} value={tot.medicines} />
        <StatCard icon={AlertTriangle} tone="amber" label={t("dashboard.lowOut")} value={`${tot.lowStock} / ${tot.outOfStock}`} />
        <StatCard icon={tot.expiredBatches > 0 ? CalendarX2 : CalendarClock} tone={tot.expiredBatches > 0 ? "red" : "amber"} label={t("dashboard.expired30d")} value={`${tot.expiredBatches} / ${tot.expiringSoon}`} />
      </div>

      {/* Sales Charts: Daily / Monthly / Yearly */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t("dashboard.revenueGrossProfit")}</h2>
            <p className="text-xs text-muted-foreground">{period === "daily" ? t("dashboard.last30d") : period === "monthly" ? t("dashboard.last12m") : t("dashboard.last5y")} (USD)</p>
          </div>
          <Tabs value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
            <TabsList>
              <TabsTrigger value="daily">{t("dashboard.daily")}</TabsTrigger>
              <TabsTrigger value="monthly">{t("dashboard.monthly")}</TabsTrigger>
              <TabsTrigger value="yearly">{t("dashboard.yearly")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            {period === "daily" ? (
              <AreaChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0f9d58" stopOpacity={0.28} /><stop offset="95%" stopColor="#0f9d58" stopOpacity={0} /></linearGradient>
                  <linearGradient id="prof" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2563eb" stopOpacity={0.22} /><stop offset="95%" stopColor="#2563eb" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5ece8" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                <Legend />
                <Area type="monotone" dataKey="revenue" name={t("dashboard.revenue")} stroke="#0f9d58" fill="url(#rev)" strokeWidth={2} />
                <Area type="monotone" dataKey="profit" name={t("dashboard.profit")} stroke="#2563eb" fill="url(#prof)" strokeWidth={2} />
              </AreaChart>
            ) : (
              <BarChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5ece8" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                <Legend />
                <Bar dataKey="revenue" name={t("dashboard.revenue")} fill="#0f9d58" radius={[6, 6, 0, 0]} />
                <Bar dataKey="profit" name={t("dashboard.profit")} fill="#2563eb" radius={[6, 6, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      {/* Best-selling + Payment distribution + Stock overview */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5 shadow-sm lg:col-span-1">
          <h2 className="mb-3 font-semibold">{t("dashboard.bestSelling90d")}</h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topData} layout="vertical" margin={{ top: 0, right: 16, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="short" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, n) => (n === "revenue" ? `$${Number(v).toFixed(2)}` : v)} />
                <Bar dataKey="qty" name={t("dashboard.units")} fill="#0f9d58" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="mb-3 font-semibold">{t("dashboard.paymentDistribution")}</h2>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={paymentChartData} dataKey="paid" nameKey="methodLabel" innerRadius={46} outerRadius={72} paddingAngle={3}>
                  {paymentChartData.map((p, i) => <Cell key={p.method} fill={PAY_COLORS[i % PAY_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 space-y-1 text-xs">
            {data.payments.map((p) => (
              <div key={p.method} className="flex items-center justify-between border-t pt-1">
                <span className="font-medium">{tryT(`catalogData.paymentMethods.${p.method}`, p.method)}</span>
                <span>{money(p.paid)} · {p.count} {t("dashboard.okShort")}{p.pending > 0 ? `, ${p.pending} ${t("dashboard.pendingShort")}` : ""}{p.failed > 0 ? `, ${p.failed} ${t("dashboard.failedShort")}` : ""}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t("dashboard.stockOverview")}</h2>
            <Link href="/admin/inventory" className="text-xs text-primary hover:underline">{t("adminNav.links.inventory")} →</Link>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stockPie} dataKey="value" nameKey="name" innerRadius={46} outerRadius={72} paddingAngle={3}>
                  {stockPie.map((s, i) => <Cell key={s.name} fill={STOCK_COLORS[i]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 border-t pt-3 text-xs">
            <div><div className="text-muted-foreground">{t("dashboard.costValuation")}</div><div className="font-bold">{money(data.stock.costValue)}</div></div>
            <div><div className="text-muted-foreground">{t("dashboard.retailValuation")}</div><div className="font-bold text-primary">{money(data.stock.retailValue)}</div></div>
          </div>
        </div>
      </div>

      {/* Recent orders */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{t("dashboard.recentOrders")}</h2>
          <Link href="/admin/orders" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t("common.viewAll")} <ArrowRight className="size-3.5" /></Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">{t("dashboard.customer")}</th>
                <th className="py-2 pr-3">{t("dashboard.channel")}</th>
                <th className="py-2 pr-3">{t("dashboard.orderCol")}</th>
                <th className="py-2 pr-3">{t("dashboard.paymentCol")}</th>
                <th className="py-2 pr-3 text-right">{t("common.total")}</th>
                <th className="py-2 text-right">{t("common.date")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.recent.map((o) => (
                <tr key={o.id} className="hover:bg-muted/30">
                  <td className="py-2.5 pr-3"><Link href={`/admin/orders/${o.id}`} className="font-mono font-medium text-primary hover:underline">{o.number}</Link></td>
                  <td className="py-2.5 pr-3">{o.fullName}</td>
                  <td className="py-2.5 pr-3 text-xs">{tryT(`status.${o.channel}`, o.channel)}</td>
                  <td className="py-2.5 pr-3"><StatusBadge status={o.status} /></td>
                  <td className="py-2.5 pr-3"><StatusBadge status={o.paymentStatus} /></td>
                  <td className="py-2.5 pr-3 text-right font-medium">{money(o.total)}</td>
                  <td className="whitespace-nowrap py-2.5 text-right text-xs text-muted-foreground">{formatDateTime(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
