"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "./common";
import { dayKey, addDays } from "@/lib/date";
import { api } from "@/lib/fetcher";

type Preset = { key: string; label: string; type: string; g?: "day" | "week" | "month" | "year"; defaultDays: number };

const PRESETS: Preset[] = [
  { key: "sales-day", label: "Daily Sales Report", type: "sales", g: "day", defaultDays: 30 },
  { key: "sales-week", label: "Weekly Sales Report", type: "sales", g: "week", defaultDays: 90 },
  { key: "sales-month", label: "Monthly Sales Report", type: "sales", g: "month", defaultDays: 365 },
  { key: "sales-year", label: "Yearly Sales Report", type: "sales", g: "year", defaultDays: 1460 },
  { key: "medicine-sales", label: "Medicine Sales Report", type: "medicine-sales", defaultDays: 30 },
  { key: "purchases", label: "Purchase Report", type: "purchases", defaultDays: 180 },
  { key: "inventory", label: "Inventory Valuation Report", type: "inventory", defaultDays: 30 },
  { key: "expiry", label: "Expiration Report", type: "expiry", defaultDays: 30 },
  { key: "customers", label: "Customer Report", type: "customers", defaultDays: 90 },
  { key: "profit-loss", label: "Profit & Loss Report", type: "profit-loss", defaultDays: 90 },
  { key: "payments", label: "Payment Report", type: "payments", defaultDays: 90 },
];

type ReportDto = { title: string; columns: string[]; rows: (string | number)[][]; summary?: [string, string | number][] };

export function ReportsClient() {
  const todayStr = dayKey(new Date());
  const [presetKey, setPresetKey] = useState("sales-day");
  const [from, setFrom] = useState(dayKey(addDays(new Date(), -29)));
  const [to, setTo] = useState(todayStr);
  const [report, setReport] = useState<ReportDto | null>(null);
  const [loading, setLoading] = useState(true);

  const preset = PRESETS.find((p) => p.key === presetKey)!;

  function choosePreset(k: string) {
    const p = PRESETS.find((x) => x.key === k)!;
    setPresetKey(k);
    setFrom(dayKey(addDays(new Date(), -(p.defaultDays - 1))));
    setTo(todayStr);
  }

  const queryString = useCallback(
    (format?: "csv") => {
      const sp = new URLSearchParams({ from, to });
      if (preset.g) sp.set("g", preset.g);
      if (format) sp.set("format", format);
      return `/api/admin/reports/${preset.type}?${sp}`;
    },
    [from, to, preset],
  );

  useEffect(() => {
    setLoading(true);
    api<ReportDto>(queryString()).then(setReport).finally(() => setLoading(false));
  }, [queryString]);

  async function exportPdf() {
    if (!report) return;
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF({ orientation: report.columns.length > 6 ? "landscape" : "portrait" });
    doc.setFontSize(14);
    doc.setTextColor(15, 157, 88);
    doc.text("Pamarcy Store — Cambodia", 14, 15);
    doc.setFontSize(11);
    doc.setTextColor(30, 30, 30);
    doc.text(report.title, 14, 22);
    let startY = 27;
    if (report.summary?.length) {
      doc.setFontSize(9);
      doc.text(report.summary.map(([k, v]) => `${k}: ${v}`).join("   |   "), 14, startY);
      startY += 6;
    }
    autoTable(doc, {
      startY,
      head: [report.columns],
      body: report.rows.map((r) => r.map((c) => String(c))),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [15, 157, 88] },
    });
    doc.save(`pamarcy-${presetKey}-${from}-${to}.pdf`);
  }

  const chartData =
    preset.type === "sales" && report
      ? report.rows.map((r) => ({ label: String(r[0]), revenue: Number(r[2]), profit: Number(r[4]) }))
      : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports & Analytics"
        subtitle="Generate financial, inventory, expiry and operational reports with CSV and PDF export"
        actions={
          <>
            <Button asChild variant="outline" disabled={!report}><a href={queryString("csv")}><FileSpreadsheet /> Export CSV</a></Button>
            <Button onClick={exportPdf} disabled={!report}><FileText /> Export PDF</Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <Button key={p.key} size="sm" variant={presetKey === p.key ? "default" : "outline"} onClick={() => choosePreset(p.key)}>{p.label}</Button>
        ))}
      </div>

      {!["inventory", "expiry"].includes(preset.type) && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-white p-3 text-sm shadow-sm">
          <span className="text-xs font-medium text-muted-foreground">Date range:</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" />
          <span>→</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" />
          {[
            ["Today", 0], ["7 Days", 6], ["30 Days", 29], ["90 Days", 89], ["1 Year", 364],
          ].map(([lbl, d]) => (
            <Button key={lbl as string} size="sm" variant="ghost" onClick={() => { setFrom(dayKey(addDays(new Date(), -(d as number)))); setTo(todayStr); }}>{lbl}</Button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-muted-foreground"><Loader2 className="mx-auto animate-spin" /></div>
      ) : report ? (
        <>
          {report.summary && report.summary.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {report.summary.map(([k, v]) => (
                <div key={k} className="rounded-2xl border bg-white p-4 shadow-sm">
                  <div className="text-xs text-muted-foreground">{k}</div>
                  <div className="mt-1 text-xl font-bold text-primary">{typeof v === "number" && /revenue|profit|cost|value|collected|discount|fee/i.test(k) ? `$${v.toFixed(2)}` : v}</div>
                </div>
              ))}
            </div>
          )}

          {chartData && chartData.length > 0 && (
            <div className="h-64 rounded-2xl border bg-white p-4 shadow-sm">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5ece8" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip formatter={(v) => `$${Number(v).toFixed(2)}`} />
                  <Legend />
                  <Bar dataKey="revenue" name="Revenue ($)" fill="#0f9d58" radius={[5, 5, 0, 0]} />
                  <Bar dataKey="profit" name="Gross Profit ($)" fill="#2563eb" radius={[5, 5, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-semibold">{report.title}</h2>
              <span className="text-xs text-muted-foreground">{report.rows.length} row(s)</span>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>{report.columns.map((c, i) => <th key={c} className={`p-3 ${i > 1 ? "text-right" : ""}`}>{c}</th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {report.rows.map((r, ri) => (
                  <tr key={ri} className="hover:bg-muted/30">
                    {r.map((cell, ci) => (
                      <td key={ci} className={`p-3 ${ci > 1 ? "text-right font-mono text-xs" : "text-xs font-medium"}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
                {report.rows.length === 0 && <tr><td colSpan={report.columns.length} className="p-8 text-center text-muted-foreground"><Download className="mx-auto mb-2 size-5 opacity-40" />No records in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
