// Authenticated AES-256-GCM encryption for database backups (pure Node ESM; never hardcodes keys).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const BACKUP_MAGIC = Buffer.from("PMRYBAK1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX_32B_RE = /^[0-9a-fA-F]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const HKDF_SALT = Buffer.from("pamarcy-store-encryption-hkdf-salt-v1", "utf8");
const HKDF_INFO = Buffer.from("pamarcy:backup-archive:v1", "utf8");
const PLACEHOLDERS = new Set(["dev", "secret", "changeme", "change-me", "replace-me", "test", "password"]);

export function parseBackupKey(rawValue = process.env.BACKUP_ENCRYPTION_KEY, envName = "BACKUP_ENCRYPTION_KEY") {
  const raw = rawValue?.trim() ?? "";
  if (!raw || PLACEHOLDERS.has(raw.toLowerCase())) {
    throw new Error(
      `${envName} must be set to a random 256-bit (32-byte) hex or base64 key in .env (e.g. \`openssl rand -hex 32\`).`,
    );
  }
  let buf;
  if (HEX_32B_RE.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
      throw new Error(`${envName} must be valid 64-character hex or 32-byte base64 key material.`);
    }
    buf = Buffer.from(normalized, "base64");
    const std = buf.toString("base64");
    if (normalized !== std && normalized !== std.replace(/=+$/, "")) {
      throw new Error(`${envName} is malformed base64 key material.`);
    }
  }
  if (buf.length !== 32) {
    throw new Error(`${envName} must decode to exactly 32 bytes (256 bits), got ${buf.length} bytes.`);
  }
  if (new Set(buf).size < 8) {
    throw new Error(`${envName} has insufficient entropy; generate a cryptographically random 32-byte key.`);
  }
  return Buffer.from(hkdfSync("sha256", buf, HKDF_SALT, HKDF_INFO, 32));
}

export function isEncryptedBackup(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= BACKUP_MAGIC.length + 2 + IV_BYTES + TAG_BYTES &&
    buf.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
  );
}

/**
 * Encrypt backup bytes with AES-256-GCM + AAD (`backup-archive:<format>`).
 * Binary layout: [8B "PMRYBAK1"][1B kidLen][kid][12B IV][16B AuthTag][ciphertext]
 */
export function encryptBackupBuffer(plainBuf, format = "json.gz", opts = {}) {
  const kid = (opts.keyId ?? process.env.BACKUP_ENCRYPTION_KEY_ID?.trim() ?? "b1");
  if (!KEY_ID_RE.test(kid)) throw new Error("BACKUP_ENCRYPTION_KEY_ID must match /^[A-Za-z0-9_-]{1,16}$/.");
  const key = opts.key ?? parseBackupKey(opts.rawKey);
  const kidBuf = Buffer.from(kid, "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`backup-archive:${format}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BACKUP_MAGIC, Buffer.from([kidBuf.length]), kidBuf, iv, tag, ct]);
}

/**
 * Decrypt and authenticate a `PMRYBAK1` backup buffer using AES-256-GCM.
 */
export function decryptBackupBuffer(encBuf, format = "json.gz", opts = {}) {
  if (!isEncryptedBackup(encBuf)) {
    throw new Error("Input is not a valid encrypted Pamarcy backup archive (missing PMRYBAK1 header).");
  }
  let offset = BACKUP_MAGIC.length;
  const kidLen = encBuf[offset];
  offset += 1;
  if (kidLen < 1 || kidLen > 16 || encBuf.length < offset + kidLen + IV_BYTES + TAG_BYTES) {
    throw new Error("Corrupted encrypted backup header.");
  }
  const kid = encBuf.subarray(offset, offset + kidLen).toString("utf8");
  offset += kidLen;
  if (!KEY_ID_RE.test(kid)) throw new Error("Invalid key ID in backup archive.");
  const iv = encBuf.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = encBuf.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ct = encBuf.subarray(offset);

  const key = opts.key ?? parseBackupKey(opts.rawKey);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(`backup-archive:${format}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
