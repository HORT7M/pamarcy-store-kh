// Encrypt, decrypt, or verify AES-256-GCM database backup archives using BACKUP_ENCRYPTION_KEY.
// Usage:
//   ... | node --env-file-if-exists=.env scripts/backup-encrypt.mjs encrypt <sql.gz|json.gz> <out.enc>
//   node --env-file-if-exists=.env scripts/backup-encrypt.mjs decrypt <in.enc> [out]
//   node --env-file-if-exists=.env scripts/backup-encrypt.mjs verify <in.enc>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { decryptBackupBuffer, encryptBackupBuffer } from "./lib/backup-crypto.mjs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

function inferFormat(filePath) {
  if (filePath.endsWith(".sql.gz.enc")) return "sql.gz";
  if (filePath.endsWith(".json.gz.enc")) return "json.gz";
  return "sql.gz";
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === "encrypt") {
  const format = arg1;
  const outPath = arg2;
  if (!format || !outPath) {
    console.error("Usage: backup-encrypt.mjs encrypt <sql.gz|json.gz> <outputPath>");
    process.exit(1);
  }
  const plain = await readStdin();
  const encrypted = encryptBackupBuffer(plain, format);
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, encrypted, { mode: 0o600 });
} else if (cmd === "decrypt") {
  const inPath = arg1;
  if (!inPath) {
    console.error("Usage: backup-encrypt.mjs decrypt <inputPath.enc> [outputPath]");
    process.exit(1);
  }
  const format = inferFormat(inPath);
  const plain = decryptBackupBuffer(readFileSync(inPath), format);
  if (arg2) {
    writeFileSync(arg2, plain, { mode: 0o600 });
    console.log(`✔ Decrypted backup written to ${arg2} (${plain.length} bytes)`);
  } else {
    process.stdout.write(plain);
  }
} else if (cmd === "verify") {
  const inPath = arg1;
  if (!inPath) {
    console.error("Usage: backup-encrypt.mjs verify <inputPath.enc>");
    process.exit(1);
  }
  const format = inferFormat(inPath);
  const gz = decryptBackupBuffer(readFileSync(inPath), format);
  const content = gunzipSync(gz);
  if (format === "json.gz") JSON.parse(content.toString("utf8"));
  console.log(`✔ Backup authenticated & verified (${format}, ${content.length} uncompressed bytes)`);
} else {
  console.error("Unknown command. Use: encrypt | decrypt | verify");
  process.exit(1);
}
