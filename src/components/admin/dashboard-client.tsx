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
  const { locale, money } = useI18n();
  const km = locale === "km";
  const [period, setPeriod] = useState<"daily" | "monthly" | "yearly">("daily");
  const t = data.totals;
  const series = period === "daily" ? data.daily : period === "monthly" ? data.monthly : data.yearly;
  const stockPie = [
    { name: km ? "ស្តុកគ្រប់គ្រាន់" : "Healthy", value: data.stock.healthy },
    { name: km ? "ស្តុកទាប" : "Low stock", value: data.stock.low },
    { name: km ? "អស់ពីស្តុក" : "Out of stock", value: data.stock.out },
  ];
  const topData = data.top.map((m) => ({ ...m, short: (km ? m.nameKm : m.nameEn).slice(0, 22) }));
  const totalPaidCount = data.payments.reduce((s, p) => s + p.count, 0);
  const totalPaidUsd = data.payments.reduce((s, p) => s + p.paid, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={km ? "ផ្ទាំងសង្ខេបឱសថស្ថាន" : "Pharmacy Dashboard"}
        subtitle={km ? "ទិដ្ឋភាពទូទៅនៃការលក់ ស្តុក ការទូទាត់ និងការផុតកំណត់" : "Real-time overview of sales, inventory, payments and expiry status"}
        actions={
          <>
            <Button asChild variant="outline"><Link href="/admin/reports">{km ? "របាយការណ៍" : "Reports"}</Link></Button>
            <Button asChild><Link href="/admin/pos">{km ? "បើក POS" : "Open POS"}</Link></Button>
          </>
        }
      />

      {/* Primary KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={DollarSign} tone="green" label={km ? "ការលក់សរុប" : "Total Sales"} value={money(t.totalSales)} sub={`${t.completedOrders} ${km ? "បានបញ្ចប់" : "completed"}`} />
        <StatCard icon={TrendingUp} tone="blue" label={km ? "ការលក់ថ្ងៃនេះ" : "Today's Sales"} value={money(t.todaySales)} sub={`${t.todayOrders} ${km ? "ការបញ្ជាទិញ" : "orders today"}`} />
        <StatCard icon={DollarSign} tone="green" label={km ? "ចំណូលខែនេះ" : "Monthly Revenue"} value={money(t.monthRevenue)} sub={`${km ? "ចំណេញ" : "Gross profit"}: ${money(t.monthProfit)}`} />
        <StatCard icon={CreditCard} tone="blue" label={km ? "ការទូទាត់ (90 ថ្ងៃ)" : "Payments (90d)"} value={money(totalPaidUsd)} sub={`${totalPaidCount} ${km ? "បានទូទាត់" : "settled"}`} />
      </div>

      {/* Operational KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatCard icon={ShoppingBag} tone="slate" label={km ? "ការបញ្ជាទិញសរុប" : "Total Orders"} value={t.totalOrders} />
        <StatCard icon={Clock} tone="amber" label={km ? "កំពុងរង់ចាំ" : "Pending Orders"} value={t.pendingOrders} />
        <StatCard icon={CheckCircle2} tone="green" label={km ? "បានបញ្ចប់" : "Completed"} value={t.completedOrders} />
        <StatCard icon={Users} tone="blue" label={km ? "អតិថិជន" : "Customers"} value={t.customers} />
        <StatCard icon={Pill} tone="green" label={km ? "ឱសថសរុប" : "Medicines"} value={t.medicines} />
        <StatCard icon={AlertTriangle} tone="amber" label={km ? "ស្តុកទាប / អស់" : "Low / Out"} value={`${t.lowStock} / ${t.outOfStock}`} />
        <StatCard icon={t.expiredBatches > 0 ? CalendarX2 : CalendarClock} tone={t.expiredBatches > 0 ? "red" : "amber"} label={km ? "ផុត / ជិតផុត" : "Expired / ≤30d"} value={`${t.expiredBatches} / ${t.expiringSoon}`} />
      </div>

      {/* Sales Charts: Daily / Monthly / Yearly */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">{km ? "ចំណូល និងប្រាក់ចំណេញ" : "Revenue & Gross Profit"}</h2>
            <p className="text-xs text-muted-foreground">{period === "daily" ? (km ? "30 ថ្ងៃចុងក្រោយ" : "Last 30 days") : period === "monthly" ? (km ? "12 ខែចុងក្រោយ" : "Last 12 months") : (km ? "5 ឆ្នាំចុងក្រោយ" : "Last 5 years")} (USD)</p>
          </div>
          <Tabs value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
            <TabsList>
              <TabsTrigger value="daily">{km ? "ប្រចាំថ្ងៃ" : "Daily"}</TabsTrigger>
              <TabsTrigger value="monthly">{km ? "ប្រចាំខែ" : "Monthly"}</TabsTrigger>
              <TabsTrigger value="yearly">{km ? "ប្រចាំឆ្នាំ" : "Yearly"}</TabsTrigger>
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
                <Area type="monotone" dataKey="revenue" name={km ? "ចំណូល" : "Revenue"} stroke="#0f9d58" fill="url(#rev)" strokeWidth={2} />
                <Area type="monotone" dataKey="profit" name={km ? "ចំណេញ" : "Profit"} stroke="#2563eb" fill="url(#prof)" strokeWidth={2} />
              </AreaChart>
            ) : (
              <BarChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5ece8" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                <Legend />
                <Bar dataKey="revenue" name={km ? "ចំណូល" : "Revenue"} fill="#0f9d58" radius={[6, 6, 0, 0]} />
                <Bar dataKey="profit" name={km ? "ចំណេញ" : "Profit"} fill="#2563eb" radius={[6, 6, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      {/* Best-selling + Payment distribution + Stock overview */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5 shadow-sm lg:col-span-1">
          <h2 className="mb-3 font-semibold">{km ? "ឱសថលក់ដាច់បំផុត (90 ថ្ងៃ)" : "Best-Selling Medicines (90d)"}</h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topData} layout="vertical" margin={{ top: 0, right: 16, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="short" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, n) => (n === "revenue" ? `$${Number(v).toFixed(2)}` : v)} />
                <Bar dataKey="qty" name={km ? "ចំនួនលក់" : "Units"} fill="#0f9d58" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <h2 className="mb-3 font-semibold">{km ? "ការបែងចែកវិធីទូទាត់" : "Payment Method Distribution"}</h2>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.payments.filter((p) => p.paid > 0)} dataKey="paid" nameKey="method" innerRadius={46} outerRadius={72} paddingAngle={3}>
                  {data.payments.map((p, i) => <Cell key={p.method} fill={PAY_COLORS[i % PAY_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 space-y-1 text-xs">
            {data.payments.map((p) => (
              <div key={p.method} className="flex items-center justify-between border-t pt-1">
                <span className="font-medium">{p.method}</span>
                <span>{money(p.paid)} · {p.count} ok{p.pending > 0 ? `, ${p.pending} pending` : ""}{p.failed > 0 ? `, ${p.failed} failed` : ""}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{km ? "ទិដ្ឋភាពស្តុក" : "Stock Overview"}</h2>
            <Link href="/admin/inventory" className="text-xs text-primary hover:underline">{km ? "មើលស្តុក" : "Inventory"} →</Link>
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
            <div><div className="text-muted-foreground">{km ? "តម្លៃដើមស្តុក" : "Cost Valuation"}</div><div className="font-bold">{money(data.stock.costValue)}</div></div>
            <div><div className="text-muted-foreground">{km ? "តម្លៃលក់រាយ" : "Retail Valuation"}</div><div className="font-bold text-primary">{money(data.stock.retailValue)}</div></div>
          </div>
        </div>
      </div>

      {/* Recent orders */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{km ? "ការបញ្ជាទិញថ្មីៗ" : "Recent Orders"}</h2>
          <Link href="/admin/orders" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">{km ? "មើលទាំងអស់" : "View all"} <ArrowRight className="size-3.5" /></Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr><th className="py-2 pr-3">#</th><th className="py-2 pr-3">{km ? "អតិថិជន" : "Customer"}</th><th className="py-2 pr-3">{km ? "ប៉ុស្តិ៍" : "Channel"}</th><th className="py-2 pr-3">{km ? "ស្ថានភាព" : "Order"}</th><th className="py-2 pr-3">{km ? "ការទូទាត់" : "Payment"}</th><th className="py-2 pr-3 text-right">{km ? "សរុប" : "Total"}</th><th className="py-2 text-right">{km ? "កាលបរិច្ឆេទ" : "Date"}</th></tr>
            </thead>
            <tbody className="divide-y">
              {data.recent.map((o) => (
                <tr key={o.id} className="hover:bg-muted/30">
                  <td className="py-2.5 pr-3"><Link href={`/admin/orders/${o.id}`} className="font-mono font-medium text-primary hover:underline">{o.number}</Link></td>
                  <td className="py-2.5 pr-3">{o.fullName}</td>
                  <td className="py-2.5 pr-3 text-xs">{o.channel}</td>
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
