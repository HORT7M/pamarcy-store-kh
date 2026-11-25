import { ENTITY_ID_RE } from "@/lib/validators";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireStaff, can } from "@/lib/auth/session";
import { MedicineForm } from "@/components/admin/medicine-form";
import { PageHeader } from "@/components/admin/common";
import { formatDate, formatDateTime } from "@/lib/date";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const dynamic = "force-dynamic";

export default async function EditMedicinePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff("medicines.read");
  const { id } = await params;
  if (!ENTITY_ID_RE.test(id)) notFound();
  const [m, cats, brands] = await Promise.all([
    prisma.medicine.findFirst({
      where: { id, deletedAt: null },
      include: { inventory: true, batches: { orderBy: { expiryDate: "asc" }, include: { supplier: { select: { name: true } } } }, movements: { orderBy: { createdAt: "desc" }, take: 30, include: { batch: { select: { batchNumber: true } } } } },
    }),
    prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, nameEn: true } }),
    prisma.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!m) notFound();
  return (
    <div>
      <PageHeader title={m.nameEn} subtitle={`${m.nameKm} · SKU ${m.sku}`} />
      <Tabs defaultValue="details">
        <TabsList className="mb-4">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="batches">Batches ({m.batches.length})</TabsTrigger>
          <TabsTrigger value="movements">Stock Movements ({m.movements.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <MedicineForm
            canDelete={can(user, "medicines.delete")}
            categories={cats.map((c) => ({ id: c.id, name: c.nameEn }))}
            brands={brands}
            initial={{
              id: m.id, nameEn: m.nameEn, nameKm: m.nameKm, genericName: m.genericName ?? "", sku: m.sku, barcode: m.barcode ?? "",
              categoryId: m.categoryId, brandId: m.brandId ?? "", manufacturer: m.manufacturer ?? "", activeIngredients: m.activeIngredients ?? "",
              dosageForm: m.dosageForm ?? "", strength: m.strength ?? "", dosageInfo: m.dosageInfo ?? "", usageInstructions: m.usageInstructions ?? "",
              warnings: m.warnings ?? "", descriptionEn: m.descriptionEn ?? "", descriptionKm: m.descriptionKm ?? "", unit: m.unit,
              price: m.price.toString(), compareAtPrice: m.compareAtPrice?.toString() ?? "", costPrice: m.costPrice.toString(),
              minStock: String(m.inventory?.minStock ?? 10), location: m.inventory?.location ?? "", imageUrl: m.imageUrl ?? "",
              requiresPrescription: m.requiresPrescription, tracksExpiry: m.tracksExpiry, isFeatured: m.isFeatured, isActive: m.isActive,
            }}
          />
        </TabsContent>
        <TabsContent value="batches">
          <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="p-3">Batch #</th><th className="p-3">Lot</th><th className="p-3">Expiry</th><th className="p-3">Supplier</th><th className="p-3 text-right">On hand</th><th className="p-3 text-right">Reserved</th><th className="p-3 text-right">Unit cost</th></tr>
              </thead>
              <tbody className="divide-y">
                {m.batches.map((b) => (
                  <tr key={b.id}>
                    <td className="p-3 font-mono font-medium">{b.batchNumber}</td><td className="p-3 text-xs">{b.lotNumber ?? "—"}</td>
                    <td className="p-3">{formatDate(b.expiryDate)}</td><td className="p-3 text-xs">{b.supplier?.name ?? "—"}</td>
                    <td className="p-3 text-right font-semibold">{b.quantity}</td><td className="p-3 text-right text-muted-foreground">{b.reserved}</td>
                    <td className="p-3 text-right">${Number(b.costPrice).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="movements">
          <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr><th className="p-3">Date</th><th className="p-3">Type</th><th className="p-3">Batch</th><th className="p-3 text-right">Change</th><th className="p-3 text-right">Balance</th><th className="p-3">Ref / Reason</th></tr>
              </thead>
              <tbody className="divide-y">
                {m.movements.map((mv) => (
                  <tr key={mv.id}>
                    <td className="whitespace-nowrap p-3 text-xs">{formatDateTime(mv.createdAt)}</td>
                    <td className="p-3 text-xs font-medium">{mv.type}</td>
                    <td className="p-3 font-mono text-xs">{mv.batch?.batchNumber ?? "—"}</td>
                    <td className={`p-3 text-right font-semibold ${mv.quantity > 0 ? "text-primary" : mv.quantity < 0 ? "text-red-600" : ""}`}>{mv.quantity > 0 ? `+${mv.quantity}` : mv.quantity}</td>
                    <td className="p-3 text-right text-xs">{mv.balanceAfter ?? "—"}</td>
                    <td className="p-3 text-xs text-muted-foreground">{[mv.reference, mv.reason].filter(Boolean).join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
