import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { normalizeKhPhone } from "./phone";

if (typeof window !== "undefined") {
  throw new Error("Security violation: src/lib/crypto.ts must never be imported in browser code.");
}

export type CryptoPurpose =
  | "db-field"
  | "db-blind-index"
  | "db-json"
  | "file-rx"
  | "backup-archive";

export type BlindIndexContext =
  | "User:email"
  | "User:phone"
  | "Order:phone"
  | "Order:email";

export type EncryptedJsonEnvelope = {
  __enc: 1;
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
};

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const HEX_32B_RE = /^[0-9a-fA-F]{64}$/;
const ENCRYPTED_STR_RE = /^enc:v1:([A-Za-z0-9_-]{1,16}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]*)$/;

const IV_BYTES = 12; // NIST SP 800-38D recommended 96-bit nonce for AES-GCM
const TAG_BYTES = 16; // Full 128-bit GCM authentication tag
const HKDF_SALT = Buffer.from("pamarcy-store-encryption-hkdf-salt-v1", "utf8");

export const FILE_ENVELOPE_MAGIC = Buffer.from("PMRYENC1", "ascii");
export const MAX_ENCRYPTED_FILE_OVERHEAD = FILE_ENVELOPE_MAGIC.length + 1 + 16 + IV_BYTES + TAG_BYTES; // 53 bytes

const PLACEHOLDER_KEYS = new Set([
  "dev",
  "secret",
  "changeme",
  "change-me",
  "replace-me",
  "test",
  "password",
]);

type ParsedKeyring = {
  sig: string;
  activeId: string;
  keys: Map<string, Buffer>;
  subkeys: Map<string, Buffer>;
};

let cachedKeyring: ParsedKeyring | null = null;
let cachedBackupKey: { sig: string; key: Buffer } | null = null;

/**
 * Parse and validate a 256-bit (32-byte) symmetric key from an environment variable.
 * Accepts 64-char hex or base64/base64url encoding exactly 32 raw bytes.
 * Never includes key material in error messages.
 */
export function parseKeyMaterial(rawValue: string | undefined, envName: string): Buffer {
  const raw = rawValue?.trim() ?? "";
  if (!raw || PLACEHOLDER_KEYS.has(raw.toLowerCase())) {
    throw new Error(
      `${envName} environment variable must be set to a 256-bit (32-byte) random key in hex or base64 (e.g. \`openssl rand -hex 32\`).`,
    );
  }

  let buf: Buffer;
  if (HEX_32B_RE.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
      throw new Error(`${envName} must be valid 64-character hex or 32-byte base64/base64url key material.`);
    }
    buf = Buffer.from(normalized, "base64");
    const expectedStandard = buf.toString("base64");
    const expectedNoPad = expectedStandard.replace(/=+$/, "");
    if (normalized !== expectedStandard && normalized !== expectedNoPad) {
      throw new Error(`${envName} is malformed base64 key material.`);
    }
  }

  if (buf.length !== 32) {
    throw new Error(`${envName} must decode to exactly 32 bytes (256 bits), received ${buf.length} bytes.`);
  }

  // Reject trivial all-zero or low-entropy patterns (e.g., repeated single byte)
  const distinctBytes = new Set<number>();
  for (let i = 0; i < buf.length; i++) distinctBytes.add(buf[i]!);
  if (distinctBytes.size < 8) {
    throw new Error(`${envName} has insufficient entropy; generate a cryptographically random 32-byte key.`);
  }

  return buf;
}

function getKeyring(): ParsedKeyring {
  const rawPrimary = process.env.DATA_ENCRYPTION_KEY?.trim() ?? "";
  const activeId = (process.env.DATA_ENCRYPTION_KEY_ID?.trim() || "v1");
  const rawRing = process.env.DATA_ENCRYPTION_KEYRING?.trim() ?? "";
  const sig = `${activeId}\0${rawPrimary}\0${rawRing}`;

  if (cachedKeyring && cachedKeyring.sig === sig) {
    return cachedKeyring;
  }

  if (!KEY_ID_RE.test(activeId)) {
    throw new Error("DATA_ENCRYPTION_KEY_ID must match /^[A-Za-z0-9_-]{1,16}$/.");
  }

  const primaryKey = parseKeyMaterial(rawPrimary, "DATA_ENCRYPTION_KEY");
  const keys = new Map<string, Buffer>();
  keys.set(activeId, primaryKey);

  if (rawRing) {
    for (const entry of rawRing.split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = entry.indexOf(":");
      if (idx <= 0) {
        throw new Error("DATA_ENCRYPTION_KEYRING entries must use the format `keyId:keyMaterial`.");
      }
      const kid = entry.slice(0, idx).trim();
      const mat = entry.slice(idx + 1).trim();
      if (!KEY_ID_RE.test(kid)) {
        throw new Error(`Invalid key ID "${kid}" in DATA_ENCRYPTION_KEYRING.`);
      }
      if (!keys.has(kid)) {
        keys.set(kid, parseKeyMaterial(mat, `DATA_ENCRYPTION_KEYRING[${kid}]`));
      }
    }
  }

  cachedKeyring = { sig, activeId, keys, subkeys: new Map() };
  return cachedKeyring;
}

/** Derive a purpose-separated 256-bit subkey via RFC 5869 HKDF-SHA256. */
export function derivePurposeSubkey(masterKey: Buffer, purpose: CryptoPurpose): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(`pamarcy:${purpose}:v1`, "utf8"), 32),
  );
}

function getSubkey(kid: string, purpose: CryptoPurpose): Buffer {
  const ring = getKeyring();
  const cacheKey = `${kid}:${purpose}`;
  const hit = ring.subkeys.get(cacheKey);
  if (hit) return hit;

  const master = ring.keys.get(kid);
  if (!master) {
    throw new Error(`Encryption key ID "${kid}" is not present in active DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEYRING.`);
  }
  const sub = derivePurposeSubkey(master, purpose);
  ring.subkeys.set(cacheKey, sub);
  return sub;
}

/** Validate that active encryption key material is configured properly. */
export function assertEncryptionConfigured(): { activeKeyId: string; keyIds: string[] } {
  const ring = getKeyring();
  return { activeKeyId: ring.activeId, keyIds: [...ring.keys.keys()] };
}

/** Get the dedicated 256-bit backup encryption subkey from BACKUP_ENCRYPTION_KEY. */
export function getBackupEncryptionKey(): Buffer {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim() ?? "";
  if (cachedBackupKey && cachedBackupKey.sig === raw) {
    return cachedBackupKey.key;
  }
  const master = parseKeyMaterial(raw, "BACKUP_ENCRYPTION_KEY");
  const key = derivePurposeSubkey(master, "backup-archive");
  cachedBackupKey = { sig: raw, key };
  return key;
}

export function isStrictEncryptionMode(): boolean {
  const v = process.env.DATA_ENCRYPTION_STRICT?.trim().toLowerCase();
  return v === "true" || v === "1";
}

// ───────────────────── String Field AEAD (AES-256-GCM) ─────────────────────

export function isEncryptedString(value: unknown): value is string {
  return typeof value === "string" && ENCRYPTED_STR_RE.test(value);
}

export function getEncryptedStringKeyId(value: string): string | null {
  const m = ENCRYPTED_STR_RE.exec(value);
  return m ? m[1]! : null;
}

export function needsFieldReencryption(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (!isEncryptedString(value)) return true;
  const kid = getEncryptedStringKeyId(value);
  return kid !== getKeyring().activeId;
}

/**
 * Encrypt a sensitive database string field using AES-256-GCM with random 96-bit IV
 * and column-bound AAD (`Model:field`). Idempotent if already encrypted.
 */
export function encryptField(plaintext: string, aadContext: string): string;
export function encryptField(plaintext: null, aadContext: string): null;
export function encryptField(plaintext: undefined, aadContext: string): undefined;
export function encryptField(plaintext: string | null | undefined, aadContext: string): string | null | undefined;
export function encryptField(plaintext: string | null | undefined, aadContext: string): string | null | undefined {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (isEncryptedString(plaintext)) return plaintext;

  const ring = getKeyring();
  const key = getSubkey(ring.activeId, "db-field");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aadContext, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${ring.activeId}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/**
 * Decrypt an AES-256-GCM encrypted database string field verifying GCM auth tag and AAD context.
 * Gracefully returns legacy plaintext unless DATA_ENCRYPTION_STRICT=true.
 */
export function decryptField(value: string, aadContext: string): string;
export function decryptField(value: null, aadContext: string): null;
export function decryptField(value: undefined, aadContext: string): undefined;
export function decryptField(value: string | null | undefined, aadContext: string): string | null | undefined;
export function decryptField(value: string | null | undefined, aadContext: string): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (!value.startsWith("enc:v1:")) {
    if (isStrictEncryptionMode()) {
      throw new Error(`Unencrypted sensitive value detected in ${aadContext} while DATA_ENCRYPTION_STRICT=true.`);
    }
    return value;
  }

  const m = ENCRYPTED_STR_RE.exec(value);
  if (!m) {
    throw new Error(`Malformed encrypted field envelope in ${aadContext}.`);
  }
  const [, kid, ivB64, tagB64, ctB64] = m;
  const key = getSubkey(kid!, "db-field");
  const iv = Buffer.from(ivB64!, "base64url");
  const tag = Buffer.from(tagB64!, "base64url");
  const ct = Buffer.from(ctB64!, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error(`Invalid IV or authentication tag length in ${aadContext}.`);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aadContext, "utf8"));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

// ───────────────────── JSON Field AEAD (AES-256-GCM) ─────────────────────

export function isEncryptedJsonEnvelope(value: unknown): value is EncryptedJsonEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    o.__enc === 1 &&
    o.v === 1 &&
    typeof o.kid === "string" &&
    KEY_ID_RE.test(o.kid) &&
    typeof o.iv === "string" &&
    typeof o.tag === "string" &&
    typeof o.ct === "string"
  );
}

export function needsJsonReencryption(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (!isEncryptedJsonEnvelope(value)) return true;
  return value.kid !== getKeyring().activeId;
}

export function encryptJson(value: unknown, aadContext: string): EncryptedJsonEnvelope | null | undefined {
  if (value === null || value === undefined) return value as null | undefined;
  if (isEncryptedJsonEnvelope(value)) return value;

  const ring = getKeyring();
  const key = getSubkey(ring.activeId, "db-json");
  const iv = randomBytes(IV_BYTES);
  const serialized = JSON.stringify(value);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aadContext, "utf8"));
  const ct = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __enc: 1,
    v: 1,
    kid: ring.activeId,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ct: ct.toString("base64url"),
  };
}

export function decryptJson<T = unknown>(value: unknown, aadContext: string): T {
  if (value === null || value === undefined) return value as T;
  if (!isEncryptedJsonEnvelope(value)) {
    if (isStrictEncryptionMode()) {
      throw new Error(`Unencrypted JSON payload detected in ${aadContext} while DATA_ENCRYPTION_STRICT=true.`);
    }
    return value as T;
  }

  const key = getSubkey(value.kid, "db-json");
  const iv = Buffer.from(value.iv, "base64url");
  const tag = Buffer.from(value.tag, "base64url");
  const ct = Buffer.from(value.ct, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error(`Invalid JSON envelope IV or tag length in ${aadContext}.`);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aadContext, "utf8"));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as T;
}

// ───────────────────── Binary File / Buffer AEAD (AES-256-GCM) ─────────────────────

export function isEncryptedBuffer(buf: Buffer): boolean {
  return buf.length >= FILE_ENVELOPE_MAGIC.length + 1 + 1 + IV_BYTES + TAG_BYTES &&
    buf.subarray(0, FILE_ENVELOPE_MAGIC.length).equals(FILE_ENVELOPE_MAGIC);
}

export function getEncryptedBufferKeyId(buf: Buffer): string | null {
  if (!isEncryptedBuffer(buf)) return null;
  const kidLen = buf[FILE_ENVELOPE_MAGIC.length]!;
  if (kidLen < 1 || kidLen > 16 || buf.length < FILE_ENVELOPE_MAGIC.length + 1 + kidLen + IV_BYTES + TAG_BYTES) {
    return null;
  }
  const kid = buf.subarray(FILE_ENVELOPE_MAGIC.length + 1, FILE_ENVELOPE_MAGIC.length + 1 + kidLen).toString("utf8");
  return KEY_ID_RE.test(kid) ? kid : null;
}

/**
 * Encrypt a binary buffer (e.g., prescription upload or database backup) using AES-256-GCM.
 * Format: [8B "PMRYENC1"][1B kidLen][kid][12B IV][16B AuthTag][ciphertext]
 */
export function encryptBuffer(
  plaintext: Buffer,
  purpose: "file-rx" | "backup-archive",
  aadContext: string,
  opts?: { keyOverride?: { id: string; key: Buffer } },
): Buffer {
  const kid = opts?.keyOverride?.id ?? getKeyring().activeId;
  const key = opts?.keyOverride?.key ?? getSubkey(kid, purpose);
  const kidBuf = Buffer.from(kid, "utf8");
  if (kidBuf.length < 1 || kidBuf.length > 16) {
    throw new Error(`Invalid encryption key ID "${kid}".`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`${purpose}:${aadContext}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([FILE_ENVELOPE_MAGIC, Buffer.from([kidBuf.length]), kidBuf, iv, tag, ct]);
}

/**
 * Decrypt and authenticate a `PMRYENC1` binary buffer using AES-256-GCM.
 */
export function decryptBuffer(
  envelope: Buffer,
  purpose: "file-rx" | "backup-archive",
  aadContext: string,
  opts?: { keyOverride?: { id?: string; key: Buffer } },
): Buffer {
  if (!isEncryptedBuffer(envelope)) {
    throw new Error(`Invalid encrypted binary envelope for ${aadContext}.`);
  }
  let offset = FILE_ENVELOPE_MAGIC.length;
  const kidLen = envelope[offset]!;
  offset += 1;
  if (kidLen < 1 || kidLen > 16 || envelope.length < offset + kidLen + IV_BYTES + TAG_BYTES) {
    throw new Error(`Corrupted encrypted binary header for ${aadContext}.`);
  }
  const kid = envelope.subarray(offset, offset + kidLen).toString("utf8");
  offset += kidLen;
  if (!KEY_ID_RE.test(kid)) {
    throw new Error(`Invalid key ID in binary envelope for ${aadContext}.`);
  }
  const iv = envelope.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = envelope.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ct = envelope.subarray(offset);

  const key = opts?.keyOverride?.key ?? getSubkey(kid, purpose);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(`${purpose}:${aadContext}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ───────────────────── Deterministic Blind Indexes (HMAC-SHA256) ─────────────────────

export function normalizeForBlindIndex(value: string, context: BlindIndexContext): string {
  if (context === "User:email" || context === "Order:email") {
    return value.trim().toLowerCase();
  }
  return normalizeKhPhone(value) ?? value.trim();
}

/**
 * Compute a deterministic, context-bound HMAC-SHA256 blind index for exact DB lookups
 * and unique constraints on encrypted columns (email, phone).
 */
export function blindIndex(value: string | null | undefined, context: BlindIndexContext, keyId?: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = normalizeForBlindIndex(trimmed, context);
  const ring = getKeyring();
  const subkey = getSubkey(keyId ?? ring.activeId, "db-blind-index");
  return createHmac("sha256", subkey).update(`${context}\0${normalized}`).digest("hex");
}

/**
 * Returns blind-index hashes across active + retired keyring keys so exact lookups
 * continue matching during online key rotation before backfill finishes.
 */
export function blindIndexCandidates(value: string, context: BlindIndexContext): string[] {
  const ring = getKeyring();
  const out: string[] = [];
  for (const kid of ring.keys.keys()) {
    const h = blindIndex(value, context, kid);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}
