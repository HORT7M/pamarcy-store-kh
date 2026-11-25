/**
 * Encrypt-at-rest backfill, key rotation & verification CLI for Pamarcy Store.
 *
 * Usage:
 *   npm run db:encrypt                # Encrypt any plaintext PII/PHI rows, blind indexes & prescription files
 *   npm run db:encrypt -- --rotate    # Re-encrypt rows & files from retired keys (DATA_ENCRYPTION_KEYRING) to active key
 *   npm run db:encrypt -- --verify    # Read-only audit: exits 1 if any sensitive field/file is unencrypted
 */
import { existsSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rawPrisma } from "../src/lib/db.ts";
import {
  assertEncryptionConfigured,
  blindIndex,
  decryptBuffer,
  decryptField,
  decryptJson,
  encryptBuffer,
  encryptField,
  encryptJson,
  getEncryptedBufferKeyId,
  isEncryptedBuffer,
  isEncryptedJsonEnvelope,
  isEncryptedString,
  needsFieldReencryption,
  needsJsonReencryption,
} from "../src/lib/crypto.ts";
import { ENCRYPTED_MODELS } from "../src/lib/db-encryption.ts";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has("--verify");
const rotate = args.has("--rotate");

const { activeKeyId, keyIds } = assertEncryptionConfigured();
console.log(`→ Encryption key active="${activeKeyId}" keyring=[${keyIds.join(", ")}] mode=${verifyOnly ? "verify" : rotate ? "rotate" : "backfill"}`);

const MODEL_ACCESSOR: Record<string, string> = {
  User: "user",
  Customer: "customer",
  Employee: "employee",
  Address: "address",
  Order: "order",
  Payment: "payment",
  PaymentTransaction: "paymentTransaction",
  Supplier: "supplier",
  Session: "session",
  PasswordResetToken: "passwordResetToken",
  AuditLog: "auditLog",
  Notification: "notification",
};

type DynamicDelegate = {
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
};

let totalRowsChecked = 0;
let totalRowsUpdated = 0;
let totalPlaintextFindings = 0;
let totalRetiredKeyFindings = 0;

for (const [modelName, spec] of Object.entries(ENCRYPTED_MODELS)) {
  const accessor = MODEL_ACCESSOR[modelName];
  if (!accessor) throw new Error(`Missing Prisma accessor for ${modelName}`);
  const delegate = (rawPrisma as unknown as Record<string, DynamicDelegate>)[accessor]!;

  const select: Record<string, boolean> = { id: true };
  for (const f of spec.fields) select[f] = true;
  for (const jf of spec.jsonFields) select[jf] = true;
  for (const bi of Object.values(spec.blindIndexes)) select[bi.hashColumn] = true;

  const rows = await delegate.findMany({ select });
  let modelUpdated = 0;

  for (const row of rows) {
    totalRowsChecked++;
    const patch: Record<string, unknown> = {};

    for (const field of spec.fields) {
      const val = row[field];
      if (typeof val !== "string") continue;
      const aad = `${modelName}:${field}`;
      const isEnc = isEncryptedString(val);
      const needsRot = needsFieldReencryption(val);

      if (!isEnc) totalPlaintextFindings++;
      else if (needsRot) totalRetiredKeyFindings++;

      if (!verifyOnly && (!isEnc || (rotate && needsRot))) {
        const plain = isEnc ? decryptField(val, aad) : val;
        patch[field] = encryptField(plain, aad);
      }

      const bi = spec.blindIndexes[field];
      if (bi) {
        const plain = isEnc ? decryptField(val, aad) : val;
        const expectedHash = blindIndex(plain, bi.context);
        if (row[bi.hashColumn] !== expectedHash) {
          if (!isEnc || !row[bi.hashColumn]) totalPlaintextFindings++;
          else totalRetiredKeyFindings++;
          if (!verifyOnly) {
            patch[bi.hashColumn] = expectedHash;
          }
        }
      }
    }

    for (const jField of spec.jsonFields) {
      const val = row[jField];
      if (val === null || val === undefined) continue;
      const aad = `${modelName}:${jField}`;
      const isEnc = isEncryptedJsonEnvelope(val);
      const needsRot = needsJsonReencryption(val);

      if (!isEnc) totalPlaintextFindings++;
      else if (needsRot) totalRetiredKeyFindings++;

      if (!verifyOnly && (!isEnc || (rotate && needsRot))) {
        const plain = isEnc ? decryptJson(val, aad) : val;
        patch[jField] = encryptJson(plain, aad);
      }
    }

    if (!verifyOnly && Object.keys(patch).length > 0) {
      await delegate.update({ where: { id: String(row.id) }, data: patch });
      modelUpdated++;
      totalRowsUpdated++;
    }
  }

  console.log(`  ${modelName.padEnd(20)} scanned=${rows.length} updated=${modelUpdated}`);
}

// Prescription files on local disk
const rxDir = path.resolve("storage/prescriptions");
let rxScanned = 0;
let rxUpdated = 0;
if (existsSync(rxDir)) {
  for (const name of readdirSync(rxDir)) {
    if (!/^[a-z0-9-]+\.(jpg|png|webp|pdf)$/.test(name)) continue;
    const fp = path.join(rxDir, name);
    const st = lstatSync(fp);
    if (!st.isFile() || st.isSymbolicLink()) continue;
    rxScanned++;
    const buf = readFileSync(fp);
    const isEnc = isEncryptedBuffer(buf);
    const kid = isEnc ? getEncryptedBufferKeyId(buf) : null;
    const needsRot = !isEnc || kid !== activeKeyId;

    if (!isEnc) totalPlaintextFindings++;
    else if (needsRot) totalRetiredKeyFindings++;

    if (!verifyOnly && (!isEnc || (rotate && needsRot))) {
      const aad = `prescription:${name}`;
      const plain = isEnc ? decryptBuffer(buf, "file-rx", aad) : buf;
      const next = encryptBuffer(plain, "file-rx", aad);
      writeFileSync(fp, next, { mode: 0o600 });
      rxUpdated++;
    }
  }
}
console.log(`  Prescription files   scanned=${rxScanned} updated=${rxUpdated}`);

await rawPrisma.$disconnect();

if (verifyOnly) {
  if (totalPlaintextFindings > 0 || (rotate && totalRetiredKeyFindings > 0)) {
    console.error(
      `✖ Verification FAILED: plaintext/missing-index findings=${totalPlaintextFindings}, retired-key findings=${totalRetiredKeyFindings}`,
    );
    process.exit(1);
  }
  console.log(`✔ Verification PASSED (${totalRowsChecked} rows & ${rxScanned} prescription files encrypted at rest)`);
} else {
  console.log(`✔ Encryption complete: ${totalRowsUpdated} DB rows & ${rxUpdated} prescription files updated`);
}
