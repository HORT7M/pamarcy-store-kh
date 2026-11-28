/**
 * Development seed. Run: npm run db:seed
 * Uses the real service layer (orders → FEFO reservation → cash payment → stock deduction)
 * to create historical POS sales so dashboards & reports have meaningful data.
 * No online payment is ever marked paid here — online seed orders stay PENDING.
 */
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { withFieldEncryption } from "../src/lib/db-encryption";
import bcrypt from "bcryptjs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function requireSeedPassword(name: string): string {
  const val = process.env[name]?.trim();
  if (!val || val.length < 8) {
    throw new Error(`Missing or weak ${name} in .env (must be at least 8 characters).`);
  }
  return val;
}
import { ROLES, PERMISSIONS, type RoleKey } from "../src/lib/auth/permissions";
import { CATEGORIES, BRANDS, MEDICINES } from "./seed-data";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { USDT_NETWORK_META } from "../src/lib/services/payments/config";

const seedBasePrisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});
const prisma = withFieldEncryption(seedBasePrisma);

const DAY = 86400000;
const pp = (daysFromNow: number) => {
  const d = new Date(Date.now() + daysFromNow * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), -7)); // Phnom Penh midnight
};
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pickOne = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PRODUCTION_SEED !== "true") {
    throw new Error("Refusing to run development seed in production (set ALLOW_PRODUCTION_SEED=true to override).");
  }
  const superAdminPassword = requireSeedPassword("SEED_SUPERADMIN_PASSWORD");
  const staffPassword = requireSeedPassword("SEED_STAFF_PASSWORD");
  const customerPassword = requireSeedPassword("SEED_CUSTOMER_PASSWORD");

  console.log("→ Roles & permissions");
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { description }, create: { key, description } });
  }
  const perms = await prisma.permission.findMany();
  const roleIds: Record<string, string> = {};
  for (const [key, r] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({ where: { key }, update: { name: r.name, isStaff: r.isStaff }, create: { key, name: r.name, isStaff: r.isStaff } });
    roleIds[key] = role.id;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const ids = perms.filter((p) => (r.permissions as readonly string[]).includes(p.key)).map((p) => ({ roleId: role.id, permissionId: p.id }));
    if (ids.length) await prisma.rolePermission.createMany({ data: ids });
  }

  console.log("→ Staff & customers");
  const staff: [string, string, RoleKey, string, string][] = [
    ["Sok Dara", "superadmin@pamarcy.com.kh", "SUPER_ADMIN", "Owner", "+85512345601"],
    ["Chan Sreypov", "admin@pamarcy.com.kh", "ADMIN", "Store Manager", "+85512345602"],
    ["Dr. Kim Sopheap", "pharmacist@pamarcy.com.kh", "PHARMACIST", "Chief Pharmacist", "+85512345603"],
    ["Heng Vannak", "cashier@pamarcy.com.kh", "CASHIER", "Cashier", "+85512345604"],
    ["Lim Rithy", "inventory@pamarcy.com.kh", "INVENTORY_STAFF", "Stock Controller", "+85512345605"],
  ];
  const staffHash = await bcrypt.hash(staffPassword, 12);
  const adminHash = await bcrypt.hash(superAdminPassword, 12);
  const staffIds: Record<string, string> = {};
  for (const [i, [name, email, role, position, phone]] of staff.entries()) {
    const u = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { name, email, phone, passwordHash: role === "SUPER_ADMIN" ? adminHash : staffHash, roleId: roleIds[role], locale: "km", employee: { create: { employeeCode: `EMP-${String(i + 1).padStart(3, "0")}`, position, licenseNo: role === "PHARMACIST" ? "PH-KH-2019-0457" : null, hiredAt: pp(-700 + i * 60) } } },
    });
    staffIds[role] = u.id;
  }
  const custHash = await bcrypt.hash(customerPassword, 12);
  const customers = [
    ["Sokha Chea", "sokha@example.com", "+85512888001", "Phnom Penh", "Chamkar Mon"],
    ["Bopha Meas", "bopha@example.com", "+85517888002", "Siem Reap", "Siem Reap"],
    ["Vuthy Long", "vuthy@example.com", "+85510888003", "Battambang", "Battambang"],
    ["Srey Neang", "sreyneang@example.com", "+85596888004", "Phnom Penh", "Tuol Kouk"],
    ["Piseth Ouk", "piseth@example.com", "+85570888005", "Kampong Cham", "Kampong Cham"],
    ["Malis Touch", "malis@example.com", "+85581888006", "Preah Sihanouk", "Sihanoukville"],
  ];
  const customerIds: string[] = [];
  for (const [name, email, phone, province, district] of customers) {
    const u = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        name, email, phone, passwordHash: custHash, roleId: roleIds.CUSTOMER,
        customer: { create: { addresses: { create: { label: "Home", fullName: name, phone, province, district, commune: "Sangkat 1", village: "Phum 3", street: `#${Math.floor(rand() * 200) + 1}, St. ${Math.floor(rand() * 500) + 1}`, isDefault: true } } } },
      },
      include: { customer: true },
    });
    customerIds.push(u.customer!.id);
  }

  console.log("→ Settings & payment methods");
  await prisma.systemSetting.upsert({ where: { key: "store" }, update: {}, create: { key: "store", value: DEFAULT_SETTINGS } });
  const methods = [
    { code: "KHQR" as const, nameEn: "KHQR (Bakong)", nameKm: "KHQR (បាគង)", enabled: true, online: true, pos: true, sortOrder: 1,
      config: { merchantName: "Pamarcy Store", merchantCity: "Phnom Penh", accountId: "", merchantType: "individual", merchantId: "", acquiringBank: "", mobileNumber: "", currencies: ["USD", "KHR"], expiryMinutes: 15 } },
    { code: "USDT" as const, nameEn: "USDT (Tether)", nameKm: "USDT (Tether)", enabled: true, online: true, pos: true, sortOrder: 2,
      config: { expiryMinutes: 60, networks: (Object.keys(USDT_NETWORK_META) as (keyof typeof USDT_NETWORK_META)[]).map((code) => ({ code, enabled: code === "TRC20", walletAddress: "", contractAddress: USDT_NETWORK_META[code].defaultContract, decimals: USDT_NETWORK_META[code].defaultDecimals, confirmations: code === "TRC20" ? 19 : code === "ERC20" ? 12 : code === "BEP20" ? 15 : 64 })) } },
    { code: "PAYPAL" as const, nameEn: "PayPal", nameKm: "PayPal", enabled: true, online: true, pos: true, sortOrder: 3, config: { brandName: "Pamarcy Store" } },
    { code: "CASH" as const, nameEn: "Cash", nameKm: "សាច់ប្រាក់", enabled: true, online: false, pos: true, sortOrder: 4, config: {} },
  ];
  for (const m of methods) await prisma.paymentMethod.upsert({ where: { code: m.code }, update: {}, create: m });

  console.log("→ Catalogue");
  const catIds: Record<string, string> = {};
  for (const [i, c] of CATEGORIES.entries()) {
    const r = await prisma.category.upsert({ where: { slug: c.slug }, update: {}, create: { slug: c.slug, nameEn: c.nameEn, nameKm: c.nameKm, icon: c.icon, imageUrl: `/images/categories/${c.img}.jpg`, sortOrder: i } });
    catIds[c.slug] = r.id;
  }
  const brandIds: Record<string, string> = {};
  for (const [slug, name, manufacturer, country] of BRANDS) {
    const r = await prisma.brand.upsert({ where: { slug }, update: {}, create: { slug, name, manufacturer, country } });
    brandIds[slug] = r.id;
  }

  console.log("→ Suppliers");
  const suppliers = [
    { name: "Mekong Pharma Distribution Co., Ltd", contactName: "Mr. Chhay Sokun", phone: "+85523880111", email: "orders@mekongpharma.com.kh", province: "Phnom Penh", district: "Sen Sok", address: "#12, St. 1986, Sangkat Phnom Penh Thmey" },
    { name: "Angkor Medical Supplies", contactName: "Ms. Ny Chanthy", phone: "+85563966222", email: "sales@angkormedical.com.kh", province: "Siem Reap", district: "Siem Reap", address: "National Road 6, Sala Kamreuk" },
    { name: "Indochina Healthcare Import-Export", contactName: "Mr. Tran Van Minh", phone: "+85523222333", email: "info@ichealthcare.asia", province: "Phnom Penh", district: "Chamkar Mon", address: "#45, Mao Tse Toung Blvd" },
  ];
  const supplierIds: string[] = [];
  for (const s of suppliers) {
    const ex = await prisma.supplier.findFirst({ where: { name: s.name } });
    supplierIds.push((ex ?? (await prisma.supplier.create({ data: s }))).id);
  }

  console.log("→ Medicines, purchases & batches");
  const existingCount = await prisma.medicine.count();
  if (existingCount === 0) {
    // One historical received purchase order per supplier
    const meds: { id: string; cost: number; expiry: boolean; idx: number }[] = [];
    for (const [idx, m] of MEDICINES.entries()) {
      const slug = m.sku.toLowerCase();
      const med = await prisma.medicine.create({
        data: {
          slug, sku: m.sku, barcode: `885${String(1000000000 + idx * 7919).slice(0, 10)}`, nameEn: m.en, nameKm: m.km, genericName: m.generic,
          descriptionEn: m.desc, descriptionKm: m.descKm, categoryId: catIds[m.cat], brandId: brandIds[m.brand], manufacturer: BRANDS.find((b) => b[0] === m.brand)?.[2],
          activeIngredients: m.ingredients, dosageForm: m.form, strength: m.strength, dosageInfo: m.dosage, usageInstructions: m.usage, warnings: m.warn,
          unit: m.unit ?? "box", price: m.price, compareAtPrice: idx % 6 === 0 ? Math.round(m.price * 1.2 * 100) / 100 : null, costPrice: m.cost,
          imageUrl: `/images/products/${m.cat}/${m.img}.jpg`, images: [`/images/products/${m.cat}/${m.img}.jpg`], requiresPrescription: !!m.rx, tracksExpiry: m.expiry !== false, isFeatured: !!m.featured,
          inventory: { create: { minStock: m.price > 20 ? 3 : 15, location: `Shelf ${String.fromCharCode(65 + (idx % 6))}-${(idx % 10) + 1}` } },
          createdAt: new Date(Date.now() - (MEDICINES.length - idx) * 3 * DAY),
        },
      });
      meds.push({ id: med.id, cost: m.cost, expiry: m.expiry !== false, idx });
    }
    for (const [si, supplierId] of supplierIds.entries()) {
      const mine = meds.filter((m) => m.idx % supplierIds.length === si);
      const items = mine.map((m) => ({ medicineId: m.id, quantity: 400, unitCost: m.cost, lineTotal: Math.round(m.cost * 400 * 100) / 100 }));
      const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
      const orderedAt = pp(-130 + si * 3);
      const po = await prisma.purchase.create({
        data: {
          number: `PO-${orderedAt.toISOString().slice(0, 10).replace(/-/g, "")}-${String(si + 1).padStart(4, "0")}`, supplierId, status: "RECEIVED",
          orderedAt, receivedAt: new Date(orderedAt.getTime() + 2 * DAY), subtotal, total: subtotal, createdById: staffIds.INVENTORY_STAFF,
          items: { create: items.map((i) => ({ ...i, receivedQuantity: i.quantity })) },
        },
        include: { items: true },
      });
      for (const it of po.items) {
        const m = mine.find((x) => x.id === it.medicineId)!;
        // Batch A: main stock, long expiry. Batch B: a short-dated batch to exercise FEFO & expiry alerts.
        const variants = [
          { suffix: "A", qty: 300, expiry: m.expiry ? pp(200 + ((m.idx * 37) % 500)) : null },
          { suffix: "B", qty: 100, expiry: m.expiry ? pp([-12, -3, 5, 20, 45, 80, 150][m.idx % 7]) : null },
        ];
        for (const v of variants) {
          const batch = await prisma.medicineBatch.create({
            data: { medicineId: m.id, batchNumber: `B${2600 + m.idx}${v.suffix}`, lotNumber: `L${(m.idx * 131) % 9999}`, expiryDate: v.expiry, manufactureDate: m.expiry ? pp(-400) : null, quantity: v.qty, costPrice: m.cost, supplierId, purchaseItemId: it.id, receivedAt: po.receivedAt! },
          });
          await prisma.stockMovement.create({ data: { medicineId: m.id, batchId: batch.id, type: "PURCHASE_RECEIVE", quantity: v.qty, unitCost: m.cost, reference: po.number, userId: staffIds.INVENTORY_STAFF, createdAt: po.receivedAt! } });
        }
        await prisma.inventory.update({ where: { medicineId: m.id }, data: { quantity: 400 } });
      }
    }
    // An open (ordered, not yet received) purchase order
    const open = meds.slice(0, 4);
    const items = open.map((m) => ({ medicineId: m.id, quantity: 200, unitCost: m.cost, lineTotal: Math.round(m.cost * 200 * 100) / 100 }));
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    await prisma.purchase.create({ data: { number: `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-9001`, supplierId: supplierIds[0], status: "ORDERED", subtotal, shippingCost: 5, total: subtotal + 5, createdById: staffIds.INVENTORY_STAFF, items: { create: items } } });
  }

  console.log("→ Discounts & banners");
  await prisma.discount.upsert({ where: { code: "WELCOME10" }, update: {}, create: { code: "WELCOME10", description: "10% off your first order (max $5)", type: "PERCENTAGE", value: 10, maxDiscount: 5, minSubtotal: 10 } });
  await prisma.discount.upsert({ where: { code: "KHMERNEWYEAR" }, update: {}, create: { code: "KHMERNEWYEAR", description: "$3 off orders over $25", type: "FIXED", value: 3, minSubtotal: 25, usageLimit: 500 } });
  if (!(await prisma.banner.count())) {
    await prisma.banner.createMany({
      data: [
        { titleEn: "Vitamins for the whole family", titleKm: "វីតាមីនសម្រាប់គ្រួសារទាំងមូល", subtitleEn: "Up to 20% off selected supplements", subtitleKm: "បញ្ចុះតម្លៃរហូតដល់ ២០% លើអាហារបំប៉នជ្រើសរើស", imageUrl: "/images/banners/banner-promo-vitamins.jpg", link: "/shop?category=vitamins-supplements", sortOrder: 1 },
        { titleEn: "Talk to our pharmacists", titleKm: "ពិគ្រោះជាមួយឱសថការីរបស់យើង", subtitleEn: "Free advice in store, by phone or Telegram", subtitleKm: "ដំបូន្មានឥតគិតថ្លៃនៅហាង តាមទូរស័ព្ទ ឬ Telegram", imageUrl: "/images/banners/banner-promo-pharmacist.jpg", link: "/shop?category=prescription-medicines", sortOrder: 2 },
      ],
    });
  }

  await seedSales(customerIds, staffIds);
  console.log("✔ Seed complete");
}

async function seedSales(customerIds: string[], staffIds: Record<string, string>) {
  if (await prisma.order.count()) return;
  console.log("→ Historical POS sales (via service layer, cash)");
  const { createOrder } = await import("../src/lib/services/orders");
  const { initiatePayment, recordCashPayment } = await import("../src/lib/services/payments");
  const otc = await prisma.medicine.findMany({ where: { requiresPrescription: false }, select: { id: true, price: true } });
  const rx = await prisma.medicine.findMany({ where: { requiresPrescription: true }, select: { id: true } });
  const popular = otc.slice(0, 12);
  let n = 0;
  for (let daysAgo = 120; daysAgo >= 0; daysAgo--) {
    const perDay = 1 + Math.floor(rand() * 4) + (daysAgo < 30 ? 1 : 0);
    for (let k = 0; k < perDay; k++) {
      const lines = new Map<string, number>();
      const count = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < count; j++) lines.set(pickOne(rand() < 0.6 ? popular : otc).id, 1 + Math.floor(rand() * 3));
      if (rand() < 0.12) lines.set(pickOne(rx).id, 1);
      const customerId = rand() < 0.35 ? pickOne(customerIds) : null;
      try {
        const order = await createOrder({ channel: "POS", items: [...lines].map(([medicineId, quantity]) => ({ medicineId, quantity })), cashierId: staffIds.CASHIER, customerId, fullName: customerId ? "Registered customer" : "Walk-in customer", phone: "+85523900888", staffCanDispenseRx: true }, staffIds.CASHIER);
        const pay = await initiatePayment(order.id, { method: "CASH", channel: "pos" }, staffIds.CASHIER);
        await recordCashPayment(pay.id, Math.ceil(Number(order.total)), staffIds.CASHIER);
        const at = new Date(pp(-daysAgo).getTime() + (8 + rand() * 12) * 3600000);
        const num = `POS-${new Date(at.getTime() + 7 * 3600000).toISOString().slice(0, 10).replace(/-/g, "")}-${String(++n).padStart(4, "0")}`;
        await prisma.order.update({ where: { id: order.id }, data: { number: num, createdAt: at, confirmedAt: at, deliveredAt: at } });
        await prisma.payment.updateMany({ where: { orderId: order.id }, data: { createdAt: at, paidAt: at } });
        await prisma.orderStatusHistory.updateMany({ where: { orderId: order.id }, data: { createdAt: at } });
        await prisma.stockMovement.updateMany({ where: { reference: order.number }, data: { createdAt: at, reference: num } });
      } catch (e) {
        console.warn("  skipped sale:", (e as Error).message);
      }
    }
  }
  console.log(`  ${n} POS sales`);
  // A few online orders awaiting payment (never marked paid by the seed)
  const meds = await prisma.medicine.findMany({ where: { requiresPrescription: false }, take: 6, select: { id: true } });
  for (const [i, cid] of customerIds.slice(0, 3).entries()) {
    const c = await prisma.customer.findUnique({ where: { id: cid }, include: { user: true, addresses: true } });
    const a = c!.addresses[0];
    await createOrder({ channel: "ONLINE", items: [{ medicineId: meds[i].id, quantity: 2 }, { medicineId: meds[i + 3].id, quantity: 1 }], customerId: cid, fullName: a.fullName, phone: a.phone, email: c!.user.email, province: a.province, district: a.district, commune: a.commune, village: a.village, street: a.street }, c!.userId);
  }
  // Clear seeding noise from notifications, keep a fresh welcome set
  await prisma.notification.deleteMany({});
  await prisma.auditLog.deleteMany({});
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
