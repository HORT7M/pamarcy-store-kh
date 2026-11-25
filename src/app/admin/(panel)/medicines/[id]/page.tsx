import { ENTITY_ID_RE } from "@/lib/validators";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/session";
import { requireStaffPage } from "@/lib/auth/guards";
import { getT } from "@/lib/i18n/server";
import { localizeCategoryName } from "@/lib/i18n/translate";
import { MedicineForm } from "@/components/admin/medicine-form";
import { PageHeader } from "@/components/admin/common";
import { formatDate, formatDateTime } from "@/lib/date";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const dynamic = "force-dynamic";

export default async function EditMedicinePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaffPage("medicines.read");
  const { id } = await params;
  if (!ENTITY_ID_RE.test(id)) notFound();
  const canInventory = can(user, "inventory.read");
  const [{ t, tryT, locale }, m, batches, movements, cats, brands] = await Promise.all([
    getT(),
    prisma.medicine.findFirst({
      where: { id, deletedAt: null },
      include: { inventory: true },
    }),
    canInventory
      ? prisma.medicineBatch.findMany({
          where: { medicineId: id },
          orderBy: { expiryDate: "asc" },
          include: { supplier: { select: { name: true } } },
        })
      : Promise.resolve([]),
    canInventory
      ? prisma.stockMovement.findMany({
          where: { medicineId: id },
          orderBy: { createdAt: "desc" },
          take: 30,
          include: { batch: { select: { batchNumber: true } } },
        })
      : Promise.resolve([]),
    prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, slug: true, nameEn: true, nameKm: true } }),
    prisma.brand.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!m) notFound();
  const primaryTitle = locale === "km" ? m.nameKm : m.nameEn;
  const secondaryName = locale === "km" ? m.nameEn : m.nameKm;
  return (
    <div>
      <PageHeader title={primaryTitle} subtitle={`${secondaryName} · SKU ${m.sku}`} />
      <Tabs defaultValue="details">
        <TabsList className="mb-4">
          <TabsTrigger value="details">{t("medicinesAdmin.tabDetails")}</TabsTrigger>
          {canInventory && <TabsTrigger value="batches">{t("medicinesAdmin.tabBatches", { n: batches.length })}</TabsTrigger>}
          {canInventory && <TabsTrigger value="movements">{t("medicinesAdmin.tabMovements", { n: movements.length })}</TabsTrigger>}
        </TabsList>
        <TabsContent value="details">
          <MedicineForm
            canDelete={can(user, "medicines.delete")}
            categories={cats.map((c) => ({ id: c.id, name: localizeCategoryName(c, locale, tryT) }))}
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
        {canInventory && (
          <TabsContent value="batches">
            <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">{t("medicinesAdmin.colBatchNo")}</th>
                    <th className="p-3">{t("medicinesAdmin.colLot")}</th>
                    <th className="p-3">{t("medicinesAdmin.colExpiry")}</th>
                    <th className="p-3">{t("medicinesAdmin.colSupplier")}</th>
                    <th className="p-3 text-right">{t("medicinesAdmin.colOnHand")}</th>
                    <th className="p-3 text-right">{t("medicinesAdmin.colReserved")}</th>
                    <th className="p-3 text-right">{t("medicinesAdmin.colUnitCost")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td className="p-3 font-mono font-medium">{b.batchNumber}</td>
                      <td className="p-3 text-xs">{b.lotNumber ?? "—"}</td>
                      <td className="p-3">{formatDate(b.expiryDate)}</td>
                      <td className="p-3 text-xs">{b.supplier?.name ?? "—"}</td>
                      <td className="p-3 text-right font-semibold">{b.quantity}</td>
                      <td className="p-3 text-right text-muted-foreground">{b.reserved}</td>
                      <td className="p-3 text-right">${Number(b.costPrice).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        )}
        {canInventory && (
          <TabsContent value="movements">
            <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">{t("common.date")}</th>
                    <th className="p-3">{t("medicinesAdmin.colType")}</th>
                    <th className="p-3">{t("medicinesAdmin.colBatchNo")}</th>
                    <th className="p-3 text-right">{t("medicinesAdmin.colChange")}</th>
                    <th className="p-3 text-right">{t("medicinesAdmin.colBalance")}</th>
                    <th className="p-3">{t("medicinesAdmin.colRefReason")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {movements.map((mv) => (
                    <tr key={mv.id}>
                      <td className="whitespace-nowrap p-3 text-xs">{formatDateTime(mv.createdAt)}</td>
                      <td className="p-3 text-xs font-medium">{tryT(`status.${mv.type}`, mv.type)}</td>
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
        )}
      </Tabs>
    </div>
  );
}
