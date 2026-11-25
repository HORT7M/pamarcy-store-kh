import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { prisma, rawPrisma } from "../../src/lib/db.ts";
import {
  assertEncryptionConfigured,
  blindIndex,
  decryptBuffer,
  decryptField,
  decryptJson,
  derivePurposeSubkey,
  encryptBuffer,
  encryptField,
  encryptJson,
  isEncryptedBuffer,
  isEncryptedJsonEnvelope,
  isEncryptedString,
  needsFieldReencryption,
  parseKeyMaterial,
} from "../../src/lib/crypto.ts";
import {
  assertDatabaseTransportSecurity,
  assertSecureHttpsUrl,
  SECRET_ENV_NAMES,
} from "../../src/lib/env.ts";
import { buildSmtpTransportConfig } from "../../src/lib/services/email.ts";
import { buildReport } from "../../src/lib/services/reports.ts";
import { readStoredPrescription, storeUpload } from "../../src/lib/upload.ts";
import { middleware } from "../../src/middleware.ts";
import { resolveOrderToken } from "../../src/lib/order-access.ts";
import {
  decryptBackupBuffer,
  encryptBackupBuffer,
  isEncryptedBackup,
  parseBackupKey,
} from "../lib/backup-crypto.mjs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function makePdfWithText(secretNote: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${secretNote}\n%%EOF\n`,
    "utf8",
  );
}

describe("Key management, HKDF separation & zero-hardcoded-keys enforcement", () => {
  it("validates 256-bit hex & base64 keys, rejects weak/placeholder keys, and never leaks key material in errors", () => {
    const hexKey = randomBytes(32).toString("hex");
    const b64Key = randomBytes(32).toString("base64");
    const b64urlKey = randomBytes(32).toString("base64url");

    assert.equal(parseKeyMaterial(hexKey, "TEST_KEY").length, 32);
    assert.equal(parseKeyMaterial(b64Key, "TEST_KEY").length, 32);
    assert.equal(parseKeyMaterial(b64urlKey, "TEST_KEY").length, 32);

    const badSamples = [
      "",
      "changeme",
      "dev",
      "secret",
      "0".repeat(64), // zero entropy
      "ab".repeat(32), // single repeated byte
      randomBytes(16).toString("hex"), // 128-bit too short
      "not-valid-key-material-at-all!!!",
    ];
    for (const bad of badSamples) {
      assert.throws(
        () => parseKeyMaterial(bad, "TEST_KEY"),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (bad.length >= 16) assert.equal(msg.includes(bad), false, "Error must never echo key material");
          return true;
        },
      );
    }

    assert.throws(() => parseBackupKey("", "BACKUP_ENCRYPTION_KEY"));
    assert.throws(() => parseBackupKey("00".repeat(32), "BACKUP_ENCRYPTION_KEY"));
    assert.equal(parseBackupKey(hexKey, "BACKUP_ENCRYPTION_KEY").length, 32);
  });

  it("derives distinct HKDF-SHA256 subkeys per cryptographic domain", () => {
    const master = randomBytes(32);
    const purposes = ["db-field", "db-blind-index", "db-json", "file-rx", "backup-archive"] as const;
    const derived = purposes.map((p) => derivePurposeSubkey(master, p).toString("hex"));
    const unique = new Set([master.toString("hex"), ...derived]);
    assert.equal(unique.size, purposes.length + 1, "All domain subkeys must be distinct from master and each other");
  });

  it("ensures encryption keys are server-only env vars with empty .env.example placeholders", () => {
    assert.ok((SECRET_ENV_NAMES as readonly string[]).includes("DATA_ENCRYPTION_KEY"));
    assert.ok((SECRET_ENV_NAMES as readonly string[]).includes("DATA_ENCRYPTION_KEYRING"));
    assert.ok((SECRET_ENV_NAMES as readonly string[]).includes("BACKUP_ENCRYPTION_KEY"));

    const envExample = readFileSync(".env.example", "utf8");
    for (const k of ["DATA_ENCRYPTION_KEY", "DATA_ENCRYPTION_KEYRING", "BACKUP_ENCRYPTION_KEY"]) {
      const m = envExample.match(new RegExp(`^${k}="([^"]*)"`, "m"));
      assert.ok(m, `.env.example must document ${k}`);
      assert.equal(m[1], "", `${k} in .env.example must be empty (never hardcoded)`);
    }

    const cryptoSrc = readFileSync("src/lib/crypto.ts", "utf8");
    assert.match(cryptoSrc, /^import "server-only";/m);
    assert.equal(/[0-9a-f]{64}/i.test(cryptoSrc), false, "src/lib/crypto.ts must never contain hardcoded 256-bit hex keys");

    const info = assertEncryptionConfigured();
    assert.ok(info.activeKeyId.length > 0);
  });
});

describe("AES-256-GCM AEAD, tamper resistance, AAD context binding & key rotation", () => {
  it("encrypts with unique random IVs and detects ciphertext, tag, and cross-column AAD tampering", () => {
    const plain = "Patient allergy: Penicillin + Sulfa drugs";
    const c1 = encryptField(plain, "Customer:notes");
    const c2 = encryptField(plain, "Customer:notes");

    assert.equal(isEncryptedString(c1), true);
    assert.equal(isEncryptedString(c2), true);
    assert.notEqual(c1, c2, "Random 96-bit IV must ensure distinct ciphertexts for identical plaintexts");
    assert.equal(c1.includes("Penicillin"), false);
    assert.equal(decryptField(c1, "Customer:notes"), plain);
    assert.equal(decryptField(c2, "Customer:notes"), plain);

    // Idempotent encryption
    assert.equal(encryptField(c1, "Customer:notes"), c1);

    // Cross-column AAD swap must fail authentication
    assert.throws(() => decryptField(c1, "Order:notes"));
    assert.throws(() => decryptField(c1, "User:name"));

    // Bit-flip tamper in ciphertext must fail GCM tag verification
    const parts = c1.split(":");
    const ctBuf = Buffer.from(parts[5]!, "base64url");
    ctBuf[0] = ctBuf[0]! ^ 0xff;
    parts[5] = ctBuf.toString("base64url");
    assert.throws(() => decryptField(parts.join(":"), "Customer:notes"));

    // JSON envelope encryption & tamper rejection
    const payload = { payer: { email_address: "buyer@example.com", name: { given_name: "Sokha" } }, amount: "18.50" };
    const encJson = encryptJson(payload, "PaymentTransaction:raw");
    assert.equal(isEncryptedJsonEnvelope(encJson), true);
    assert.equal(JSON.stringify(encJson).includes("buyer@example.com"), false);
    assert.deepEqual(decryptJson(encJson, "PaymentTransaction:raw"), payload);
    assert.throws(() => decryptJson(encJson, "AuditLog:meta"));
  });

  it("supports zero-downtime key rotation via DATA_ENCRYPTION_KEYRING", () => {
    const origKey = process.env.DATA_ENCRYPTION_KEY;
    const origId = process.env.DATA_ENCRYPTION_KEY_ID;
    const origRing = process.env.DATA_ENCRYPTION_KEYRING;
    const k1 = randomBytes(32).toString("hex");
    const k2 = randomBytes(32).toString("hex");

    try {
      process.env.DATA_ENCRYPTION_KEY = k1;
      process.env.DATA_ENCRYPTION_KEY_ID = "rot1";
      process.env.DATA_ENCRYPTION_KEYRING = "";

      const ctV1 = encryptField("sokha@example.com", "User:email");
      const bufV1 = encryptBuffer(Buffer.from("Rx secret bytes"), "file-rx", "prescription:rx1.pdf");
      assert.equal(needsFieldReencryption(ctV1), false);

      // Rotate active key to rot2 while keeping rot1 in DATA_ENCRYPTION_KEYRING
      process.env.DATA_ENCRYPTION_KEY = k2;
      process.env.DATA_ENCRYPTION_KEY_ID = "rot2";
      process.env.DATA_ENCRYPTION_KEYRING = `rot1:${k1}`;

      assert.equal(decryptField(ctV1, "User:email"), "sokha@example.com");
      assert.equal(decryptBuffer(bufV1, "file-rx", "prescription:rx1.pdf").toString("utf8"), "Rx secret bytes");
      assert.equal(needsFieldReencryption(ctV1), true, "Retired key ciphertext must be flagged for re-encryption");

      const ctV2 = encryptField("sokha@example.com", "User:email");
      assert.ok(ctV2.startsWith("enc:v1:rot2:"));
      assert.equal(needsFieldReencryption(ctV2), false);
      assert.equal(decryptField(ctV2, "User:email"), "sokha@example.com");

      // After retiring rot1 from keyring, rot1 ciphertexts can no longer be decrypted
      process.env.DATA_ENCRYPTION_KEYRING = "";
      assert.throws(() => decryptField(ctV1, "User:email"), /rot1/);
      assert.equal(decryptField(ctV2, "User:email"), "sokha@example.com");
    } finally {
      process.env.DATA_ENCRYPTION_KEY = origKey;
      process.env.DATA_ENCRYPTION_KEY_ID = origId;
      process.env.DATA_ENCRYPTION_KEYRING = origRing;
    }
  });
});

describe("Live PostgreSQL field-level encryption at rest & transparent decryption", () => {
  it("stores ZERO plaintext PII/PHI in PostgreSQL while preserving exact lookups, relations, and reports", async () => {
    // 1. Verify existing seeded User rows are encrypted in raw PostgreSQL
    const seededRawUsers = await rawPrisma.user.findMany({
      take: 5,
      select: { id: true, name: true, email: true, phone: true, emailHash: true },
    });
    assert.ok(seededRawUsers.length > 0, "Expected seeded users in database");
    for (const ru of seededRawUsers) {
      assert.equal(isEncryptedString(ru.name), true, `Raw User.name (${ru.id}) must be encrypted`);
      assert.equal(isEncryptedString(ru.email), true, `Raw User.email (${ru.id}) must be encrypted`);
      if (ru.phone) assert.equal(isEncryptedString(ru.phone), true, `Raw User.phone (${ru.id}) must be encrypted`);
      assert.ok(ru.emailHash && /^[0-9a-f]{64}$/.test(ru.emailHash), "User.emailHash must be a 64-char HMAC blind index");
    }

    // 2. Create synthetic PII/PHI/financial records through `prisma` and verify raw DB ciphertext
    const uniq = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const testEmail = `enc.patient.${uniq}@example.com`;
    const testPhone = `+85596${String(Math.floor(1000000 + Math.random() * 8999999))}`;
    const testName = `Patient Secret ${uniq}`;
    const testNotes = `Severe penicillin allergy (${uniq})`;
    const testDob = "1991-04-15";
    const testStreet = `#42 Private Lane (${uniq})`;
    const testInstructions = `Gate code 9912 (${uniq})`;
    const testRxNote = `Verified Amoxicillin 500mg prescription (${uniq})`;
    const testTaxId = `VAT-KH-${uniq}`;
    const testPayer = `paypal-payer-${uniq}@example.com`;

    const role = await prisma.role.findUniqueOrThrow({ where: { key: "CUSTOMER" } });
    const cashMethod = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "CASH" } });

    let createdUserId: string | null = null;
    let createdOrderId: string | null = null;
    let createdSupplierId: string | null = null;
    let createdAuditId: string | null = null;

    try {
      const createdUser = await prisma.user.create({
        data: {
          name: testName,
          email: testEmail,
          phone: testPhone,
          passwordHash: "$2b$12$NYpoS/dfeCGkgcAlTAkJCuNS19qDA6xUmxK0x76ESpNOZiZK5zXcq",
          roleId: role.id,
          customer: {
            create: {
              dateOfBirth: testDob,
              gender: "female",
              notes: testNotes,
              addresses: {
                create: {
                  label: "Home",
                  fullName: testName,
                  phone: testPhone,
                  province: "Phnom Penh",
                  district: "Doun Penh",
                  commune: "Boeng Raing",
                  village: "Phum 1",
                  street: testStreet,
                  instructions: testInstructions,
                  isDefault: true,
                },
              },
            },
          },
        },
        include: { customer: { include: { addresses: true } } },
      });
      createdUserId = createdUser.id;
      assert.equal(createdUser.name, testName);
      assert.equal(createdUser.email, testEmail);
      assert.equal(createdUser.phone, testPhone);
      assert.equal(createdUser.customer?.dateOfBirth, testDob);
      assert.equal(createdUser.customer?.notes, testNotes);
      assert.equal(createdUser.customer?.addresses[0]?.street, testStreet);

      const order = await prisma.order.create({
        data: {
          number: `PM-ENCTEST-${uniq}`,
          channel: "ONLINE",
          customerId: createdUser.customer!.id,
          fullName: testName,
          phone: testPhone,
          email: testEmail,
          province: "Phnom Penh",
          district: "Doun Penh",
          street: testStreet,
          instructions: testInstructions,
          prescriptionNote: testRxNote,
          notes: `Internal clinical note ${uniq}`,
          subtotal: 10,
          total: 10,
          exchangeRate: 4100,
          payments: {
            create: {
              reference: `PAY-ENCTEST-${uniq}`,
              methodId: cashMethod.id,
              amountUsd: 10,
              currency: "USD",
              amount: 10,
              payerInfo: testPayer,
              qrString: `sensitive-qr-token-${uniq}`,
              transactions: {
                create: {
                  type: "VERIFY",
                  status: "ok",
                  raw: { payerEmail: testPayer, bankAccount: "secret@aclb" },
                },
              },
            },
          },
        },
        include: { payments: { include: { transactions: true } } },
      });
      createdOrderId = order.id;

      const supplier = await prisma.supplier.create({
        data: {
          name: `Test Pharma Supplier ${uniq}`,
          contactName: `Contact ${uniq}`,
          phone: testPhone,
          email: `vendor.${uniq}@example.com`,
          address: testStreet,
          taxId: testTaxId,
          notes: `Confidential vendor pricing ${uniq}`,
        },
      });
      createdSupplierId = supplier.id;

      const auditRow = await prisma.auditLog.create({
        data: {
          userId: createdUserId,
          action: "encryption.test",
          entity: "User",
          entityId: createdUserId,
          ip: "203.0.113.42",
          meta: { detail: `sensitive-meta-${uniq}` },
        },
      });
      createdAuditId = auditRow.id;

      // Inspect RAW PostgreSQL rows directly -> MUST be encrypted ciphertext, ZERO plaintext!
      const rawUser = await rawPrisma.user.findUniqueOrThrow({
        where: { id: createdUserId },
        include: { customer: { include: { addresses: true } } },
      });
      assert.equal(isEncryptedString(rawUser.name), true);
      assert.equal(isEncryptedString(rawUser.email), true);
      assert.equal(isEncryptedString(rawUser.phone), true);
      assert.equal(rawUser.email.includes(testEmail), false);
      assert.equal(rawUser.emailHash, blindIndex(testEmail, "User:email"));
      assert.equal(rawUser.phoneHash, blindIndex(testPhone, "User:phone"));
      assert.equal(isEncryptedString(rawUser.customer?.dateOfBirth), true);
      assert.equal(isEncryptedString(rawUser.customer?.gender), true);
      assert.equal(isEncryptedString(rawUser.customer?.notes), true);
      assert.equal(rawUser.customer?.notes?.includes("penicillin"), false);
      assert.equal(isEncryptedString(rawUser.customer?.addresses[0]?.street), true);
      assert.equal(isEncryptedString(rawUser.customer?.addresses[0]?.instructions), true);

      const rawOrder = await rawPrisma.order.findUniqueOrThrow({
        where: { id: createdOrderId },
        include: { payments: { include: { transactions: true } } },
      });
      assert.equal(isEncryptedString(rawOrder.fullName), true);
      assert.equal(isEncryptedString(rawOrder.phone), true);
      assert.equal(isEncryptedString(rawOrder.email), true);
      assert.equal(isEncryptedString(rawOrder.street), true);
      assert.equal(isEncryptedString(rawOrder.prescriptionNote), true);
      assert.equal(rawOrder.prescriptionNote?.includes("Amoxicillin"), false);
      assert.equal(rawOrder.phoneHash, blindIndex(testPhone, "Order:phone"));
      assert.equal(isEncryptedString(rawOrder.payments[0]?.payerInfo), true);
      assert.equal(isEncryptedString(rawOrder.payments[0]?.qrString), true);
      assert.equal(isEncryptedJsonEnvelope(rawOrder.payments[0]?.transactions[0]?.raw), true);
      assert.equal(JSON.stringify(rawOrder.payments[0]?.transactions[0]?.raw).includes(testPayer), false);

      const rawSupplier = await rawPrisma.supplier.findUniqueOrThrow({ where: { id: createdSupplierId } });
      assert.equal(isEncryptedString(rawSupplier.taxId), true);
      assert.equal(isEncryptedString(rawSupplier.contactName), true);
      assert.equal(isEncryptedString(rawSupplier.phone), true);
      assert.equal(rawSupplier.taxId?.includes(testTaxId), false);

      const rawAudit = await rawPrisma.auditLog.findUniqueOrThrow({ where: { id: createdAuditId } });
      assert.equal(isEncryptedString(rawAudit.ip), true);
      assert.equal(isEncryptedJsonEnvelope(rawAudit.meta), true);
      assert.equal(JSON.stringify(rawAudit.meta).includes(uniq), false);

      // Verify transparent blind-index queries & decryption via `prisma`
      const byEmail = await prisma.user.findUnique({ where: { email: testEmail.toUpperCase() } });
      assert.equal(byEmail?.id, createdUserId);
      assert.equal(byEmail?.email, testEmail);
      assert.equal(byEmail?.name, testName);

      const localFormatPhone = testPhone.replace("+855", "0");
      const byPhone = await prisma.user.findFirst({ where: { phone: localFormatPhone } });
      assert.equal(byPhone?.id, createdUserId);

      const orderCountByPhone = await prisma.order.count({ where: { phone: localFormatPhone } });
      assert.ok(orderCountByPhone >= 1);

      const decOrder = await prisma.order.findUniqueOrThrow({
        where: { id: createdOrderId },
        include: { payments: { include: { transactions: true } } },
      });
      assert.equal(decOrder.prescriptionNote, testRxNote);
      assert.equal(decOrder.payments[0]?.payerInfo, testPayer);
      assert.deepEqual(decOrder.payments[0]?.transactions[0]?.raw, {
        payerEmail: testPayer,
        bankAccount: "secret@aclb",
      });

      const decAudit = await prisma.auditLog.findUniqueOrThrow({ where: { id: createdAuditId } });
      assert.equal(decAudit.ip, "203.0.113.42");
      assert.deepEqual(decAudit.meta, { detail: `sensitive-meta-${uniq}` });

      // Customer report decrypts raw SQL results cleanly
      const report = await buildReport("customers", new Date(0), new Date(Date.now() + 86_400_000));
      const row = report.rows.find((r) => r[1] === testEmail);
      assert.ok(row, "Customer report must include decrypted customer email");
      assert.equal(row[0], testName);
      assert.equal(row[2], testPhone);
    } finally {
      if (createdAuditId) await rawPrisma.auditLog.delete({ where: { id: createdAuditId } }).catch(() => {});
      if (createdOrderId) await rawPrisma.order.delete({ where: { id: createdOrderId } }).catch(() => {});
      if (createdSupplierId) await rawPrisma.supplier.delete({ where: { id: createdSupplierId } }).catch(() => {});
      if (createdUserId) await rawPrisma.user.delete({ where: { id: createdUserId } }).catch(() => {});
    }
  });
});

describe("Encrypted prescription files & encrypted database backups at rest", () => {
  const cleanupPaths: string[] = [];

  after(() => {
    for (const p of cleanupPaths) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("encrypts private prescription files on disk with AES-256-GCM + filename AAD and detects tampering", async () => {
    const marker = `PATIENT-RX-DIAGNOSIS-${randomUUID()}`;
    const pdf = makePdfWithText(marker);
    const file = new File([new Uint8Array(pdf)], "patient-rx.pdf", { type: "application/pdf" });

    const stored = await storeUpload(file, "prescriptions", { actorUserId: "user_enc_test" });
    const rxPath = path.resolve("storage", "prescriptions", stored.fileName);
    cleanupPaths.push(rxPath);

    // Raw bytes on disk must be encrypted (PMRYENC1) with zero plaintext PDF header or diagnosis text
    const diskBytes = readFileSync(rxPath);
    assert.equal(isEncryptedBuffer(diskBytes), true, "Prescription file on disk must have PMRYENC1 header");
    assert.equal(diskBytes.subarray(0, 5).toString("ascii"), "PMRYE");
    assert.equal(diskBytes.includes(Buffer.from("%PDF-")), false, "Plaintext PDF header must not appear on disk");
    assert.equal(diskBytes.includes(Buffer.from(marker)), false, "Patient diagnosis text must not appear on disk");

    // Authorized read transparently decrypts & re-verifies PDF structure
    const dec = await readStoredPrescription(stored.fileName);
    assert.equal(dec.mime, "application/pdf");
    assert.equal(dec.buffer.equals(pdf), true);

    // Copying ciphertext to another UUID filename fails AAD context verification
    const swappedName = `${randomUUID()}.pdf`;
    const swappedPath = path.resolve("storage", "prescriptions", swappedName);
    cleanupPaths.push(swappedPath);
    writeFileSync(swappedPath, diskBytes, { mode: 0o600 });
    await assert.rejects(() => readStoredPrescription(swappedName), (err: unknown) => (err as { status?: number }).status === 415);

    // 1-bit tamper on disk fails GCM authentication tag
    const tampered = Buffer.from(diskBytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    writeFileSync(rxPath, tampered, { mode: 0o600 });
    await assert.rejects(() => readStoredPrescription(stored.fileName), (err: unknown) => (err as { status?: number }).status === 415);
  });

  it("encrypts database backups with BACKUP_ENCRYPTION_KEY and ensures zero plaintext backups remain on disk", () => {
    const sample = gzipSync(Buffer.from(JSON.stringify({ secret: "patient-record-123" })));
    const enc = encryptBackupBuffer(sample, "json.gz");

    assert.equal(isEncryptedBackup(enc), true);
    assert.equal(enc.includes(Buffer.from("patient-record-123")), false);
    assert.equal(enc[0] === 0x1f && enc[1] === 0x8b, false, "Encrypted backup must not start with plaintext gzip magic");

    const dec = decryptBackupBuffer(enc, "json.gz");
    assert.equal(gunzipSync(dec).toString("utf8"), JSON.stringify({ secret: "patient-record-123" }));

    // Wrong format AAD fails
    assert.throws(() => decryptBackupBuffer(enc, "sql.gz"));

    // Wrong key fails
    const otherKey = parseBackupKey(randomBytes(32).toString("hex"), "OTHER");
    assert.throws(() => decryptBackupBuffer(enc, "json.gz", { key: otherKey }));

    // 1-bit tamper fails
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x80;
    assert.throws(() => decryptBackupBuffer(tampered, "json.gz"));

    // On-disk backups directory must contain zero unencrypted .json.gz / .sql.gz files
    if (existsSync("backups")) {
      const files = readdirSync("backups");
      for (const f of files) {
        assert.equal(/\.(json|sql)(\.gz)?$/i.test(f), false, `Unencrypted backup found on disk: backups/${f}`);
        if (f.endsWith(".enc")) {
          const buf = readFileSync(path.join("backups", f));
          assert.equal(isEncryptedBackup(buf), true, `backups/${f} must be a valid PMRYBAK1 encrypted archive`);
        }
      }
    }
  });
});

describe("Encryption in transit enforcement (HTTPS redirect, DB TLS, SMTP TLS, outbound HTTPS)", () => {
  it("redirects plaintext HTTP requests to HTTPS (308) with HSTS in production or when ENFORCE_HTTPS=true", () => {
    const origEnforce = process.env.ENFORCE_HTTPS;
    const origAppUrl = process.env.APP_URL;
    try {
      process.env.ENFORCE_HTTPS = "true";
      process.env.APP_URL = "https://pamarcy.com.kh";

      // Plaintext HTTP arriving behind proxy (x-forwarded-proto: http) MUST redirect even when APP_URL is https://
      const httpReq = new NextRequest("http://pamarcy.com.kh/checkout?step=2", {
        headers: { "x-forwarded-proto": "http", host: "pamarcy.com.kh" },
      });
      const res = middleware(httpReq);
      assert.equal(res.status, 308);
      assert.equal(res.headers.get("location"), "https://pamarcy.com.kh/checkout?step=2");
      assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=63072000/);
      assert.equal(res.headers.get("cache-control"), "private, no-store");

      // Already-HTTPS request proceeds normally (not 308)
      const httpsReq = new NextRequest("https://pamarcy.com.kh/checkout", {
        headers: { "x-forwarded-proto": "https", host: "pamarcy.com.kh" },
      });
      const okRes = middleware(httpsReq);
      assert.notEqual(okRes.status, 308);
    } finally {
      process.env.ENFORCE_HTTPS = origEnforce;
      process.env.APP_URL = origAppUrl;
    }
  });

  it("enforces PostgreSQL TLS sslmode in production or when DATABASE_SSL_REQUIRE=true without leaking credentials", () => {
    const secretPw = "SuperSecretDbPass999!";
    const remotePlain = `postgresql://appuser:${secretPw}@db.pamarcy.com.kh:5432/pamarcy?schema=public`;
    const remoteDisable = `${remotePlain}&sslmode=disable`;
    const remotePrefer = `${remotePlain}&sslmode=prefer`;
    const remoteRequire = `${remotePlain}&sslmode=require`;
    const remoteVerifyFull = `${remotePlain}&sslmode=verify-full`;

    for (const bad of [remotePlain, remoteDisable, remotePrefer]) {
      assert.throws(
        () => assertDatabaseTransportSecurity(bad, { nodeEnv: "production" }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.equal(msg.includes(secretPw), false, "DB TLS error must never leak database password");
          assert.match(msg, /sslmode/);
          return true;
        },
      );
    }

    assert.doesNotThrow(() => assertDatabaseTransportSecurity(remoteRequire, { nodeEnv: "production" }));
    assert.doesNotThrow(() => assertDatabaseTransportSecurity(remoteVerifyFull, { nodeEnv: "production" }));

    // Localhost fails when DATABASE_SSL_REQUIRE=true, passes when false in dev
    const localUrl = "postgresql://postgres:localpw@localhost:5433/pamarcy?schema=public";
    assert.throws(() => assertDatabaseTransportSecurity(localUrl, { nodeEnv: "development", sslRequireEnv: "true" }));
    assert.doesNotThrow(() => assertDatabaseTransportSecurity(localUrl, { nodeEnv: "development", sslRequireEnv: "false" }));
  });

  it("enforces mandatory TLSv1.2+ / STARTTLS for SMTP email transport", () => {
    const starttls = buildSmtpTransportConfig({ host: "smtp.pamarcy.com.kh", port: 587, user: "u", pass: "p", isProduction: true });
    assert.equal(starttls.secure, false);
    assert.equal(starttls.requireTLS, true);
    assert.equal(starttls.tls.minVersion, "TLSv1.2");
    assert.equal(starttls.tls.rejectUnauthorized, true);

    const smtps = buildSmtpTransportConfig({ host: "smtp.pamarcy.com.kh", port: 465, user: "u", pass: "p", isProduction: true });
    assert.equal(smtps.secure, true);
    assert.equal(smtps.requireTLS, false);
    assert.equal(smtps.tls.minVersion, "TLSv1.2");
    assert.equal(smtps.tls.rejectUnauthorized, true);

    // allowInsecureLocal MUST be ignored in production and for remote hosts
    const prodOverrideAttempt = buildSmtpTransportConfig({ host: "localhost", port: 587, allowInsecureLocal: true, isProduction: true });
    assert.equal(prodOverrideAttempt.requireTLS, true);
    assert.equal(prodOverrideAttempt.tls.rejectUnauthorized, true);

    const remoteOverrideAttempt = buildSmtpTransportConfig({ host: "smtp.example.com", port: 587, allowInsecureLocal: true, isProduction: false });
    assert.equal(remoteOverrideAttempt.requireTLS, true);
    assert.equal(remoteOverrideAttempt.tls.rejectUnauthorized, true);
  });

  it("enforces HTTPS on outbound payment gateway and blockchain RPC URLs", () => {
    assert.equal(assertSecureHttpsUrl("https://api-bakong.nbc.gov.kh", "BAKONG_API_BASE"), "https://api-bakong.nbc.gov.kh");
    assert.throws(
      () => assertSecureHttpsUrl("http://eth-mainnet.g.alchemy.com/v2/SECRET_API_KEY_12345", "ETHEREUM_RPC_URL"),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.equal(msg.includes("SECRET_API_KEY_12345"), false, "HTTPS check error must never leak RPC API key");
        return /https:\/\//.test(msg);
      },
    );
    assert.throws(() => assertSecureHttpsUrl("http://api-bakong.nbc.gov.kh", "BAKONG_API_BASE"));
    assert.throws(() => assertSecureHttpsUrl("http://api.trongrid.io", "TRONGRID_API_BASE"));
    assert.doesNotThrow(() => assertSecureHttpsUrl("http://localhost:3000", "APP_URL", { allowHttpLocalhost: true }));
    assert.throws(() => assertSecureHttpsUrl("http://pamarcy.com.kh", "APP_URL", { allowHttpLocalhost: true }));
  });

  it("prefers x-order-token request header over URL query token for order/payment API calls", () => {
    const reqWithHdr = new NextRequest("https://pamarcy.com.kh/api/orders/ord_1", {
      headers: { "x-order-token": "header_token_value_1234567890" },
    });
    assert.equal(resolveOrderToken(reqWithHdr, "query_fallback_1234567890"), "header_token_value_1234567890");
    const reqWithoutHdr = new NextRequest("https://pamarcy.com.kh/api/orders/ord_1");
    assert.equal(resolveOrderToken(reqWithoutHdr, "query_fallback_1234567890"), "query_fallback_1234567890");
  });
});

after(async () => {
  await prisma.$disconnect();
  await rawPrisma.$disconnect();
});
