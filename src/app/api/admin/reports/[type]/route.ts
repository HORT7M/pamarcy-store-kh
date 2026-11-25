import { apiHandler, parseParams, parseQuery } from "@/lib/api";
import { requireStaff } from "@/lib/auth/session";
import { buildReport, type ReportType } from "@/lib/services/reports";
import { addDays, parseDateInput, startOfDayPP } from "@/lib/date";
import { adminReportParamSchema, adminReportQuerySchema } from "@/lib/validators";
import { audit } from "@/lib/audit";
import { sanitizeFilename } from "@/lib/sanitize";

function csvCell(v: string | number) {
  let s = String(v ?? "");
  // Guard against spreadsheet formula injection even when preceded by whitespace or control chars
  if (typeof v === "string" && (/^[\s\u0000-\u001f]*[=+\-@]/.test(s) || /^[\t\r]/.test(s))) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/admin/reports/:type?from=YYYY-MM-DD&to=YYYY-MM-DD&g=day|week|month|year&format=json|csv */
export const GET = apiHandler<{ type: string }>(async (req, { params }) => {
  const user = await requireStaff("reports.view");
  const { type } = await parseParams(params, adminReportParamSchema);
  const t = type as ReportType;
  const q = parseQuery(req, adminReportQuerySchema);
  const to = q.to ? addDays(parseDateInput(q.to), 1) : addDays(startOfDayPP(), 1);
  const from = q.from ? parseDateInput(q.from) : addDays(to, -30);
  const report = await buildReport(t, from, to, q.g ?? "day");
  if (q.format === "csv") {
    await audit(user.id, "report.export_csv", "Report", t, { from: q.from ?? null, to: q.to ?? null });
    const lines = [report.columns.map(csvCell).join(","), ...report.rows.map((r) => r.map(csvCell).join(","))];
    if (report.summary?.length) lines.push("", ...report.summary.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`));
    return new Response("\uFEFF" + lines.join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${sanitizeFilename(`pamarcy-${t}-${q.from ?? "from"}-${q.to ?? "to"}.csv`, "pamarcy-report.csv")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  }
  return report;
});
