import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { jsPDF } from "jspdf";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

import {
  MAX_UPLOAD_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  buildSafeFileHeaders,
  createPrescriptionClaimUrl,
  inspectFileBuffer,
  pruneOrphanPrescriptions,
  readBoundedFormData,
  readStoredPrescription,
  readStoredPublicImage,
  storeUpload,
  validateFileName,
  validateMimeType,
  validateUploadFile,
  verifyAndResolvePrescriptionClaim,
} from "../../src/lib/upload.ts";
import {
  bannerSchema,
  checkoutSchema,
  isSafeAppLink,
  isSafeImageUrl,
  medicineSchema,
} from "../../src/lib/validators.ts";
import { ApiError } from "../../src/lib/errors.ts";
import { prisma } from "../../src/lib/db.ts";
import { createOrder, cancelOrder } from "../../src/lib/services/orders.ts";
import { orderAccessToken } from "../../src/lib/order-access.ts";

const APP = process.env.APP_URL || "http://localhost:3000";
const cleanupPaths: string[] = [];

// ───────────────────── Test Fixture Builders ─────────────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Build a valid minimal 1x1 RGB PNG with optional extra chunks inserted before IDAT. */
function makeValidPng(extraChunks: Buffer[] = [], width = 1, height = 1): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  const idatData = deflateSync(Buffer.from([0x00, 0x10, 0x80, 0x40]));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdrData),
    ...extraChunks,
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Load a real JPEG fixture from public/images. */
function loadRealJpeg(): Buffer {
  return readFileSync("public/images/products/paracetamol-500.jpg");
}

/** Insert a JPEG marker segment right after SOI (FF D8). */
function insertJpegSegment(jpeg: Buffer, markerByte: number, payload: Buffer): Buffer {
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = markerByte;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

/** Build a valid minimal VP8L WebP image (1x1). */
function makeValidWebpVp8l(): Buffer {
  const vp8lPayload = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // 1x1 lossless header
  const chunkHdr = Buffer.alloc(8);
  chunkHdr.write("VP8L", 0, "ascii");
  chunkHdr.writeUInt32LE(vp8lPayload.length, 4);
  const body = Buffer.concat([chunkHdr, vp8lPayload]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "ascii");
  return Buffer.concat([riff, body]);
}

/** Build a valid VP8X WebP with optional EXIF or XMP chunk. */
function makeValidWebpVp8x(metaFourCC?: "EXIF" | "XMP ", metaPayload?: Buffer): Buffer {
  const vp8xPayload = Buffer.alloc(10);
  if (metaFourCC === "EXIF") vp8xPayload[0] = 0x08;
  if (metaFourCC === "XMP ") vp8xPayload[0] = 0x04;
  // width-1 = 0, height-1 = 0 (1x1)
  const makeChunk = (cc: string, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(cc, 0, "ascii");
    h.writeUInt32LE(data.length, 4);
    return data.length & 1 ? Buffer.concat([h, data, Buffer.from([0])]) : Buffer.concat([h, data]);
  };
  const vp8lPayload = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const parts = [makeChunk("VP8X", vp8xPayload), makeChunk("VP8L", vp8lPayload)];
  if (metaFourCC && metaPayload) parts.push(makeChunk(metaFourCC, metaPayload));
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "ascii");
  return Buffer.concat([riff, body]);
}

/** Build a valid clean PDF using jsPDF. */
function makeValidPdf(): Buffer {
  const doc = new jsPDF();
  doc.text("Dr. Sokha Clinic - Rx: Amoxicillin 500mg", 10, 20);
  return Buffer.from(doc.output("arraybuffer"));
}

function makeFile(buf: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(buf)], name, { type });
}

function assertApiError(fn: () => unknown, expectedStatus: number, pattern?: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ApiError, `Expected ApiError, got ${String(err)}`);
    assert.equal(err.status, expectedStatus, `Expected HTTP ${expectedStatus}, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

async function assertApiErrorAsync(fn: () => Promise<unknown>, expectedStatus: number, pattern?: RegExp) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ApiError, `Expected ApiError, got ${String(err)}`);
    assert.equal(err.status, expectedStatus, `Expected HTTP ${expectedStatus}, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

// ───────────────────── 1. Filename & Extension Validation ─────────────────────

describe("Upload filename & extension validation", () => {
  it("accepts valid extensions and normalizes .jpeg -> jpg", () => {
    assert.equal(validateFileName("product-1.jpg", false), "jpg");
    assert.equal(validateFileName("Photo 2026.JPEG", false), "jpg");
    assert.equal(validateFileName("label_v2.png", false), "png");
    assert.equal(validateFileName("hero.webp", false), "webp");
    assert.equal(validateFileName("prescription.pdf", true), "pdf");
    assertApiError(() => validateFileName("prescription.pdf", false), 415);
  });

  it("blocks executable, script, active-content, double-extension, and traversal filenames", () => {
    const blocked415 = [
      "shell.php",
      "shell.php.jpg",
      "shell.phtml.png",
      "dropper.exe",
      "dropper.exe.jpg",
      "xss.svg",
      "xss.svg.webp",
      "page.html",
      "page.html.pdf",
      "exploit.jsp.png",
      "script.js.jpg",
      "macro.sh.png",
      "payload.bat.jpg",
      "archive.zip",
      "module.wasm",
      "noextension",
      "image.gif",
    ];
    for (const name of blocked415) {
      assertApiError(() => validateFileName(name, true), 415);
    }

    const blocked400 = [
      "",
      "../secret.jpg",
      "..\\secret.jpg",
      "sub/dir/file.jpg",
      "null\x00byte.jpg",
      "ctrl\nchar.png",
      ".htaccess",
      ".hidden.jpg",
      "trailing..jpg",
      "trailing.jpg.",
      "CON.jpg",
      "NUL.png",
      `${"a".repeat(252)}.jpg`,
    ];
    for (const name of blocked400) {
      assertApiError(() => validateFileName(name, true), 400);
    }
  });
});

// ───────────────────── 2. MIME Type & Cross-Layer Consistency ─────────────────────

describe("MIME type allowlist & cross-layer spoofing defense", () => {
  it("enforces strict MIME allowlist", () => {
    assert.equal(validateMimeType("image/jpeg", false), "jpg");
    assert.equal(validateMimeType("IMAGE/PNG", false), "png");
    assert.equal(validateMimeType("image/webp", false), "webp");
    assert.equal(validateMimeType("application/pdf", true), "pdf");

    for (const badMime of [
      "",
      "application/pdf",
      "image/svg+xml",
      "image/gif",
      "text/html",
      "application/javascript",
      "application/x-php",
      "application/octet-stream",
    ]) {
      assertApiError(() => validateMimeType(badMime, false), 415);
    }
  });

  it("blocks extension/MIME/signature mismatches (polyglot & content-type spoofing)", async () => {
    const png = makeValidPng();
    const jpg = loadRealJpeg();
    const pdf = makeValidPdf();

    // Extension vs MIME mismatch
    await assertApiErrorAsync(() => validateUploadFile(makeFile(png, "fake.jpg", "image/png"), false), 415, /does not match/i);
    // MIME + extension say JPEG, actual magic bytes are PNG
    await assertApiErrorAsync(() => validateUploadFile(makeFile(png, "fake.jpg", "image/jpeg"), false), 415, /does not match/i);
    // MIME + extension say PNG, actual magic bytes are JPEG
    await assertApiErrorAsync(() => validateUploadFile(makeFile(jpg, "fake.png", "image/png"), false), 415, /does not match/i);
    // PDF disguised as JPEG
    await assertApiErrorAsync(() => validateUploadFile(makeFile(pdf, "rx.jpg", "image/jpeg"), true), 415, /does not match/i);
  });
});

// ───────────────────── 3. Deep Signature, Structure, Executable & Sanitization ─────────────────────

describe("Deep binary signature inspection, executable blocking & sanitization", () => {
  it("accepts genuine JPEG, PNG, WebP, and clean PDF files", async () => {
    const j = await validateUploadFile(makeFile(loadRealJpeg(), "med.jpg", "image/jpeg"), false);
    assert.equal(j.ext, "jpg");
    assert.equal(j.mime, "image/jpeg");
    assert.ok((j.width ?? 0) > 0 && (j.height ?? 0) > 0);

    const p = await validateUploadFile(makeFile(makeValidPng(), "label.png", "image/png"), false);
    assert.equal(p.ext, "png");
    assert.equal(p.width, 1);

    const w = await validateUploadFile(makeFile(makeValidWebpVp8l(), "banner.webp", "image/webp"), false);
    assert.equal(w.ext, "webp");
    assert.equal(w.width, 1);

    const pdf = await validateUploadFile(makeFile(makeValidPdf(), "rx.pdf", "application/pdf"), true);
    assert.equal(pdf.ext, "pdf");
    assert.equal(pdf.mime, "application/pdf");
  });

  it("rejects executable binaries, scripts, archives, HTML, and SVG even when spoofed as .jpg/.pdf", async () => {
    const payloads: [string, Buffer][] = [
      ["PE/MZ exe", Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64)])],
      ["ELF binary", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), Buffer.alloc(64)])],
      ["Mach-O binary", Buffer.concat([Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), Buffer.alloc(64)])],
      ["WebAssembly", Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(32)])],
      ["Shell script", Buffer.from("#!/bin/sh\nid && cat /etc/passwd\n")],
      ["PHP webshell", Buffer.from("<?php system($_GET['cmd']); ?>\n")],
      ["SVG XSS", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')],
      ["HTML XSS", Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>")],
      ["ZIP/JAR archive", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])],
      ["Gzip archive", Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64)])],
    ];

    for (const [label, buf] of payloads) {
      await assertApiErrorAsync(
        () => validateUploadFile(makeFile(buf, "innocent.jpg", "image/jpeg"), true),
        415,
      );
      assertApiError(() => inspectFileBuffer(buf, true), 415);
      assert.ok(label);
    }
  });

  it("strips benign JPEG COM comments and blocks JPEG polyglots, embedded PHP, and trailing payloads", () => {
    const baseJpeg = loadRealJpeg();

    // Benign comment is stripped
    const withBenignCom = insertJpegSegment(baseJpeg, 0xfe, Buffer.from("Camera Note 2026"));
    const clean = inspectFileBuffer(withBenignCom, false);
    assert.equal(clean.buffer.includes(Buffer.from("Camera Note 2026")), false, "JPEG COM segment must be stripped");

    // Embedded PHP in JPEG COM segment is rejected
    const withPhpCom = insertJpegSegment(baseJpeg, 0xfe, Buffer.from("<?php eval($_POST['x']); ?>"));
    assertApiError(() => inspectFileBuffer(withPhpCom, false), 415, /Embedded script/i);

    // Embedded script in JPEG APP1 EXIF segment is rejected
    const withXssExif = insertJpegSegment(baseJpeg, 0xe1, Buffer.from("Exif\0\0<script>alert(1)</script>"));
    assertApiError(() => inspectFileBuffer(withXssExif, false), 415, /Embedded script/i);

    // Polyglot trailing payload appended after EOI (FF D9) is rejected
    const withTrailing = Buffer.concat([baseJpeg, Buffer.from("<?php echo 1; ?>")]);
    assertApiError(() => inspectFileBuffer(withTrailing, false), 415, /Trailing data/i);

    // Fake JPEG magic bytes only
    const fakeMagic = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("not a real jpeg image at all....")]);
    assertApiError(() => inspectFileBuffer(fakeMagic, false), 415);
  });

  it("strips benign PNG text chunks and blocks PNG CRC tampering, embedded scripts, trailing data, and dimension bombs", () => {
    // Benign tEXt stripped
    const withText = makeValidPng([pngChunk("tEXt", Buffer.from("Comment\0Pharmacy Photo"))]);
    const clean = inspectFileBuffer(withText, false);
    assert.equal(clean.buffer.includes(Buffer.from("Pharmacy Photo")), false, "PNG tEXt chunk must be stripped");

    // Embedded script in tEXt blocked
    const withScriptText = makeValidPng([pngChunk("tEXt", Buffer.from("Note\0<script>alert(1)</script>"))]);
    assertApiError(() => inspectFileBuffer(withScriptText, false), 415, /Embedded script/i);

    // Embedded PHP in compressed zTXt blocked
    const ztxtData = Buffer.concat([Buffer.from("Comment\0"), Buffer.from([0]), deflateSync(Buffer.from("<?php phpinfo(); ?>"))]);
    const withScriptZtxt = makeValidPng([pngChunk("zTXt", ztxtData)]);
    assertApiError(() => inspectFileBuffer(withScriptZtxt, false), 415, /Embedded script/i);

    // Corrupted CRC rejected
    const badCrc = Buffer.from(makeValidPng());
    badCrc[badCrc.length - 1] ^= 0xff;
    assertApiError(() => inspectFileBuffer(badCrc, false), 415, /CRC/i);

    // Trailing payload after IEND rejected
    const withTrail = Buffer.concat([makeValidPng(), Buffer.from("polyglot-tail")]);
    assertApiError(() => inspectFileBuffer(withTrail, false), 415, /Trailing data/i);

    // Dimension decompression bomb (20000x20000) rejected
    const hugeDims = makeValidPng([], 20000, 20000);
    assertApiError(() => inspectFileBuffer(hugeDims, false), 400, /dimensions exceed/i);
  });

  it("strips benign WebP EXIF/XMP metadata and blocks WebP metadata XSS & trailing data", () => {
    const withExif = makeValidWebpVp8x("EXIF", Buffer.from("GPS: 11.5564, 104.9282"));
    const clean = inspectFileBuffer(withExif, false);
    assert.equal(clean.buffer.includes(Buffer.from("11.5564")), false, "WebP EXIF metadata must be stripped");
    // Re-inspecting sanitized WebP must succeed cleanly (RIFF length & VP8X flags remain valid)
    const rechecked = inspectFileBuffer(clean.buffer, false);
    assert.equal(rechecked.ext, "webp");

    // Embedded SVG/script in XMP blocked
    const withXssXmp = makeValidWebpVp8x("XMP ", Buffer.from("<svg onload=alert(1)>"));
    assertApiError(() => inspectFileBuffer(withXssXmp, false), 415, /Embedded script/i);

    // Trailing bytes past RIFF size blocked
    const withTrail = Buffer.concat([makeValidWebpVp8l(), Buffer.from("extra-evil")]);
    assertApiError(() => inspectFileBuffer(withTrail, false), 415, /trailing data|mismatch/i);
  });

  it("blocks active/executable PDFs (/JavaScript, /Launch, /AA, obfuscated #XX, /ObjStm JS, trailing data)", () => {
    const cleanPdf = makeValidPdf().toString("latin1");

    const maliciousVariants = [
      cleanPdf.replace("/Catalog", "/Catalog /Names << /JavaScript 9 0 R >>"),
      cleanPdf.replace("/Catalog", "/Catalog /Names << /J#61vaScript 9 0 R >>"),
      cleanPdf.replace("/Catalog", "/Catalog /AA << /O << /S /Launch /F (cmd.exe) >> >>"),
      cleanPdf.replace("/OpenAction [3 0 R /FitH null]", "/OpenAction << /S /JS /JS (app.alert(1)) >>"),
      cleanPdf.replace("/Catalog", "/Catalog /EmbeddedFiles << >>"),
      `${cleanPdf}\n<?php system($_GET['x']); ?>`,
    ];

    for (const bad of maliciousVariants) {
      assertApiError(() => inspectFileBuffer(Buffer.from(bad, "latin1"), true), 415);
    }

    // Compressed /ObjStm hiding /JavaScript inside a FlateDecode stream
    const hiddenObj = deflateSync(Buffer.from("10 0 << /S /JavaScript /JS (app.alert(1)) >>"));
    const objStmPdf = Buffer.concat([
      Buffer.from("%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length "),
      Buffer.from(String(hiddenObj.length)),
      Buffer.from(" >>\nstream\n"),
      hiddenObj,
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);
    assertApiError(() => inspectFileBuffer(objStmPdf, true), 415, /JavaScript/i);
  });
});

// ───────────────────── 4. Size Limits & Bounded Multipart Parsing ─────────────────────

describe("Upload size bounds & DoS-resistant multipart parsing", () => {
  it("rejects empty, tiny, and oversized files (> 5 MB)", async () => {
    await assertApiErrorAsync(() => validateUploadFile(makeFile(Buffer.alloc(0), "empty.jpg", "image/jpeg"), false), 400, /empty/i);
    await assertApiErrorAsync(() => validateUploadFile(makeFile(Buffer.from("tiny"), "tiny.jpg", "image/jpeg"), false), 400, /too small/i);
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    await assertApiErrorAsync(() => validateUploadFile(makeFile(oversized, "big.jpg", "image/jpeg"), false), 413, /too large/i);
  });

  it("rejects non-multipart requests and oversized chunked streams without Content-Length", async () => {
    const jsonReq = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "nope" }),
    });
    await assertApiErrorAsync(() => readBoundedFormData(jsonReq), 415, /multipart\/form-data/i);

    const badLenReq = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=----test",
        "content-length": String(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES + 1024),
      },
      body: "ignored",
    });
    await assertApiErrorAsync(() => readBoundedFormData(badLenReq), 413, /too large/i);

    // Streaming chunked request WITHOUT Content-Length header that exceeds budget
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES + 128 * 1024) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(64 * 1024);
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const chunkedReq = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----test" },
      body: stream,
      // @ts-expect-error Node fetch duplex option for streaming request body
      duplex: "half",
    });
    await assertApiErrorAsync(() => readBoundedFormData(chunkedReq), 413, /too large/i);
  });
});

// ───────────────────── 5. Safe Filenames, Isolated Storage & Symlink Blocking ─────────────────────

describe("Safe filename generation, isolated storage & filesystem hardening", () => {
  it("stores files outside /public with UUIDv4 names, 0600 permissions, and blocks symlinks & tampering", async () => {
    const png = makeValidPng();
    const storedPub = await storeUpload(makeFile(png, "Patient Secret (2026) !.PNG", "image/png"), "products");
    const pubPath = path.resolve("storage", "uploads", "products", storedPub.fileName);
    cleanupPaths.push(pubPath);

    // Safe UUIDv4 filename with zero client filename leakage
    assert.match(storedPub.fileName, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/);
    assert.equal(storedPub.url, `/api/files/uploads/products/${storedPub.fileName}`);
    assert.equal(existsSync(path.resolve("public", "uploads", "products", storedPub.fileName)), false, "Must NEVER write into public/uploads");
    assert.equal(existsSync(pubPath), true);

    if (process.platform !== "win32") {
      const mode = statSync(pubPath).mode & 0o777;
      assert.equal(mode, 0o600, `Stored file must be 0600 (non-executable, owner-only), got ${mode.toString(8)}`);
      const dirMode = statSync(path.dirname(pubPath)).mode & 0o777;
      assert.equal(dirMode & 0o077, 0, `Storage dir must not be group/world accessible, got ${dirMode.toString(8)}`);
    }

    // Verified read works
    const readBack = await readStoredPublicImage("products", storedPub.fileName);
    assert.equal(readBack.mime, "image/png");

    // Path traversal blocked
    await assertApiErrorAsync(() => readStoredPublicImage("products", "../prescriptions/x.png"), 404);
    await assertApiErrorAsync(() => readStoredPublicImage("../etc", "passwd.png"), 404);

    // Symlink placed inside storage directory MUST be rejected
    const linkName = `${randomUUID()}.png`;
    const linkPath = path.resolve("storage", "uploads", "products", linkName);
    cleanupPaths.push(linkPath);
    await symlink(pubPath, linkPath);
    await assertApiErrorAsync(() => readStoredPublicImage("products", linkName), 404);

    // On-disk tampering (e.g. file overwritten with PHP) blocked on read
    await writeFile(pubPath, Buffer.from("<?php echo 'pwned'; ?>"), { mode: 0o600 });
    await assertApiErrorAsync(() => readStoredPublicImage("products", storedPub.fileName), 415);

    // Private prescription upload + signed claim + orphan cleanup
    const pdf = makeValidPdf();
    const storedRx = await storeUpload(makeFile(pdf, "rx-scan.pdf", "application/pdf"), "prescriptions", { actorUserId: "user_alice" });
    const rxPath = path.resolve("storage", "prescriptions", storedRx.fileName);
    cleanupPaths.push(rxPath);
    assert.match(storedRx.url, /^\/api\/files\/prescriptions\/[0-9a-f-]+\.pdf\?claim=\d+\.[A-Za-z0-9_-]+$/);

    // Stored private prescription can be read & re-verified; traversal rejected
    const rxBack = await readStoredPrescription(storedRx.fileName);
    assert.equal(rxBack.mime, "application/pdf");
    await assertApiErrorAsync(() => readStoredPrescription("../uploads/products/a.pdf"), 404);

    // Valid claim resolves to canonical URL (query stripped)
    const claimed = await verifyAndResolvePrescriptionClaim(storedRx.url, "user_alice");
    assert.equal(claimed.canonicalUrl, `/api/files/prescriptions/${storedRx.fileName}`);

    // Cross-user claim theft rejected
    await assertApiErrorAsync(() => verifyAndResolvePrescriptionClaim(storedRx.url, "user_bob"), 400);
    await assertApiErrorAsync(() => verifyAndResolvePrescriptionClaim(storedRx.url, null), 400);

    // Forged / tampered / expired claims rejected
    await assertApiErrorAsync(() => verifyAndResolvePrescriptionClaim(`${storedRx.url}X`, "user_alice"), 400);
    await assertApiErrorAsync(() => verifyAndResolvePrescriptionClaim(`/api/files/prescriptions/${storedRx.fileName}`, "user_alice"), 400);
    const expiredClaim = createPrescriptionClaimUrl(storedRx.fileName, "user_alice", -10_000);
    await assertApiErrorAsync(() => verifyAndResolvePrescriptionClaim(expiredClaim, "user_alice"), 400, /expired/i);

    // Safe headers enforce nosniff, sandbox CSP, and attachment for PDFs
    const pdfHdrs = buildSafeFileHeaders("application/pdf", storedRx.fileName, "private");
    assert.equal(pdfHdrs["X-Content-Type-Options"], "nosniff");
    assert.match(pdfHdrs["Content-Security-Policy"]!, /sandbox/);
    assert.match(pdfHdrs["Content-Disposition"]!, /^attachment;/);
    assert.match(pdfHdrs["Cache-Control"]!, /no-store/);

    // Orphan pruning removes old unreferenced prescription files, preserves referenced ones
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(rxPath, oldDate, oldDate);
    assert.equal(await pruneOrphanPrescriptions(new Set([claimed.canonicalUrl])), 0);
    assert.equal(existsSync(rxPath), true);
    assert.equal(await pruneOrphanPrescriptions(new Set()), 1);
    assert.equal(existsSync(rxPath), false);
  });
});

// ───────────────────── 6. URL Injection & Schema Validation ─────────────────────

describe("URL injection & prescription claim validation in Zod schemas", () => {
  it("blocks javascript:, data:, arbitrary hosts, and path traversal in imageUrl / link / prescriptionUrl", () => {
    assert.equal(isSafeImageUrl("/images/products/paracetamol-500.jpg"), true);
    assert.equal(isSafeImageUrl("/api/files/uploads/products/123e4567-e89b-42d3-a456-426614174000.jpg"), true);
    assert.equal(isSafeImageUrl("https://res.cloudinary.com/demo/image/upload/v1/sample.jpg"), true);

    for (const badImg of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "https://evil.example.com/tracker.jpg",
      "http://res.cloudinary.com/insecure.jpg",
      "/uploads/products/legacy.jpg",
      "/images/../.env",
      "/images/products/evil.svg",
      "//evil.example.com/a.jpg",
    ]) {
      assert.equal(isSafeImageUrl(badImg), false, `Should reject imageUrl: ${badImg}`);
    }

    assert.equal(isSafeAppLink("/shop?category=pain"), true);
    assert.equal(isSafeAppLink("https://pamarcy.com.kh/promo"), true);
    assert.equal(isSafeAppLink("javascript:alert(1)"), false);
    assert.equal(isSafeAppLink("//evil.example.com/phish"), false);

    assert.equal(
      checkoutSchema.safeParse({
        items: [{ medicineId: "m1", quantity: 1 }],
        fullName: "Test Buyer",
        phone: "012 345 678",
        province: "Phnom Penh",
        district: "Doun Penh",
        prescriptionUrl: "javascript:alert(document.cookie)",
      }).success,
      false,
    );

    assert.equal(
      bannerSchema.safeParse({
        titleEn: "Promo",
        titleKm: "ប្រូម៉ូសិន",
        imageUrl: "javascript:alert(1)",
        link: "/shop",
      }).success,
      false,
    );

    assert.equal(
      medicineSchema.safeParse({
        nameEn: "Test Med",
        nameKm: "ថ្នាំ",
        sku: "TST-1",
        categoryId: "cat1",
        price: 5,
        costPrice: 2,
        imageUrl: "https://evil.example.com/x.jpg",
      }).success,
      false,
    );
  });

  it("prevents replaying the same prescription upload across multiple orders", async () => {
    const rxMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: true, deletedAt: null } });
    const storedRx = await storeUpload(makeFile(makeValidPdf(), "rx-once.pdf", "application/pdf"), "prescriptions", { actorUserId: null });
    const rxPath = path.resolve("storage", "prescriptions", storedRx.fileName);
    cleanupPaths.push(rxPath);

    const order1 = await createOrder(
      {
        channel: "ONLINE",
        items: [{ medicineId: rxMed.id, quantity: 1 }],
        fullName: "Rx Guest 1",
        phone: "+85512999888",
        province: "Phnom Penh",
        district: "Doun Penh",
        prescriptionUrl: storedRx.url,
      },
      null,
    );
    assert.equal(order1.prescriptionUrl, `/api/files/prescriptions/${storedRx.fileName}`);

    // Replaying the exact same claim URL on a second order MUST fail with 409 Conflict
    await assertApiErrorAsync(
      () =>
        createOrder(
          {
            channel: "ONLINE",
            items: [{ medicineId: rxMed.id, quantity: 1 }],
            fullName: "Rx Guest 2",
            phone: "+85512999888",
            province: "Phnom Penh",
            district: "Doun Penh",
            prescriptionUrl: storedRx.url,
          },
          null,
        ),
      409,
      /already been linked/i,
    );

    // Cleanup DB order cleanly
    await cancelOrder(order1.id, null, "Upload security test cleanup", { system: true });
    await prisma.order.delete({ where: { id: order1.id } });
  });
});

// ───────────────────── 7. Live HTTP Upload & Storage Access Control Tests ─────────────────────

async function loginAs(identifier: string, password: string, scope: "admin" | "customer"): Promise<string> {
  const res = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP },
    body: JSON.stringify({ identifier, password, scope }),
  });
  assert.equal(res.status, 200, `Login failed for ${identifier} (HTTP ${res.status})`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(cookie.startsWith("pamarcy_session="));
  return cookie;
}

describe("Live HTTP upload & private storage access control", () => {
  it("enforces RBAC, executable rejection, sandbox headers, and prescription least-privilege over HTTP", async (t) => {
    try {
      const ping = await fetch(`${APP}/api/categories`);
      if (!ping.ok) return t.skip("Live app server not running");
    } catch {
      return t.skip("Live app server not running");
    }

    const staffPass = process.env.SEED_STAFF_PASSWORD ?? "";
    const custPass = process.env.SEED_CUSTOMER_PASSWORD ?? "";
    if (!staffPass || !custPass) return t.skip("Seed passwords not set in environment");

    const cashierCookie = await loginAs("cashier@pamarcy.com.kh", staffPass, "admin");
    const pharmacistCookie = await loginAs("pharmacist@pamarcy.com.kh", staffPass, "admin");
    const customerCookie = await loginAs("sokha@example.com", custPass, "customer");

    // 1. Unauthenticated upload to products -> 401
    {
      const fd = new FormData();
      fd.append("folder", "products");
      fd.append("file", makeFile(makeValidPng(), "a.png", "image/png"));
      const r = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP }, body: fd });
      assert.equal(r.status, 401);
    }

    // 2. Cashier lacks medicines.write -> 403 on products upload
    {
      const fd = new FormData();
      fd.append("folder", "products");
      fd.append("file", makeFile(makeValidPng(), "a.png", "image/png"));
      const r = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP, Cookie: cashierCookie }, body: fd });
      assert.equal(r.status, 403);
    }

    // 3. Pharmacist lacks discounts.write -> 403 on banners upload
    {
      const fd = new FormData();
      fd.append("folder", "banners");
      fd.append("file", makeFile(makeValidPng(), "b.png", "image/png"));
      const r = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP, Cookie: pharmacistCookie }, body: fd });
      assert.equal(r.status, 403);
    }

    // 4. Executable PHP disguised as .png -> 415 Unsupported Media Type
    {
      const fd = new FormData();
      fd.append("folder", "products");
      fd.append("file", makeFile(Buffer.from("<?php system($_GET['c']); ?>"), "shell.png", "image/png"));
      const r = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP, Cookie: pharmacistCookie }, body: fd });
      assert.equal(r.status, 415);
    }

    // 5. Double-extension shell.php.png -> 415
    {
      const fd = new FormData();
      fd.append("folder", "products");
      fd.append("file", makeFile(makeValidPng(), "shell.php.png", "image/png"));
      const r = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP, Cookie: pharmacistCookie }, body: fd });
      assert.equal(r.status, 415);
    }

    // 6. Valid product image upload by Pharmacist -> 200 (or 400 fail-closed if server is prod without Cloudinary/ALLOW_LOCAL_UPLOADS)
    {
      const fd = new FormData();
      fd.append("folder", "products");
      fd.append("file", makeFile(makeValidPng(), "medicine.png", "image/png"));
      const r = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP, Cookie: pharmacistCookie }, body: fd });
      let publicUrl: string;
      if (r.status === 200) {
        const j = (await r.json()) as { url: string };
        assert.match(j.url, /^\/api\/files\/uploads\/products\/[0-9a-f-]+\.png$/);
        publicUrl = j.url;
        cleanupPaths.push(path.resolve("storage", "uploads", "products", j.url.split("/").pop()!));
      } else {
        // Production server intentionally fails closed when neither Cloudinary nor ALLOW_LOCAL_UPLOADS is configured
        assert.equal(r.status, 400);
        const errBody = (await r.json()) as { error?: { message?: string } };
        assert.match(errBody.error?.message ?? "", /storage is not configured/i);
        const stored = await storeUpload(makeFile(makeValidPng(), "medicine.png", "image/png"), "products");
        publicUrl = stored.url;
        cleanupPaths.push(path.resolve("storage", "uploads", "products", stored.fileName));
      }

      const served = await fetch(`${APP}${publicUrl}`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get("content-type"), "image/png");
      assert.equal(served.headers.get("x-content-type-options"), "nosniff");
      assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);

      // Traversal / invalid folder on public uploads endpoint -> 404
      const trav = await fetch(`${APP}/api/files/uploads/prescriptions/${publicUrl.split("/").pop()}`);
      assert.equal(trav.status, 404);
    }

    // 7. Customer prescription PDF -> Rx order -> full RBAC & security header verification on /api/files/prescriptions/:name
    {
      const custUser = await prisma.user.findUniqueOrThrow({ where: { email: "sokha@example.com" }, select: { id: true } });
      const fd = new FormData();
      fd.append("folder", "prescriptions");
      fd.append("file", makeFile(makeValidPdf(), "my-rx.pdf", "application/pdf"));
      const up = await fetch(`${APP}/api/uploads`, { method: "POST", headers: { Origin: APP, Cookie: customerCookie }, body: fd });
      let claimUrl: string;
      if (up.status === 200) {
        claimUrl = ((await up.json()) as { url: string }).url;
      } else {
        assert.equal(up.status, 400);
        const stored = await storeUpload(makeFile(makeValidPdf(), "my-rx.pdf", "application/pdf"), "prescriptions", { actorUserId: custUser.id });
        claimUrl = stored.url;
      }
      const canonicalPath = claimUrl.split("?")[0]!;
      const fname = canonicalPath.split("/").pop()!;
      cleanupPaths.push(path.resolve("storage", "prescriptions", fname));

      const rxMed = await prisma.medicine.findFirstOrThrow({ where: { requiresPrescription: true, deletedAt: null } });
      const ordRes = await fetch(`${APP}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP, Cookie: customerCookie },
        body: JSON.stringify({
          items: [{ medicineId: rxMed.id, quantity: 1 }],
          fullName: "Sokha Chan",
          phone: "012 345 678",
          province: "Phnom Penh",
          district: "Doun Penh",
          prescriptionUrl: claimUrl,
        }),
      });
      assert.equal(ordRes.status, 200, `Order creation failed: ${ordRes.status}`);
      const ord = (await ordRes.json()) as { id: string; token: string };
      try {
      // Unauthenticated -> 401
      const unauthRx = await fetch(`${APP}${canonicalPath}`);
      assert.equal(unauthRx.status, 401);

      // Cashier (has orders.read, NOT prescriptions.review) -> 403 Forbidden!
      const cashierRx = await fetch(`${APP}${canonicalPath}`, { headers: { Cookie: cashierCookie } });
      assert.equal(cashierRx.status, 403);

      // Cashier inspecting admin order detail must have prescriptionUrl redacted
      const cashierOrd = await fetch(`${APP}/api/admin/orders/${ord.id}`, { headers: { Cookie: cashierCookie } });
      assert.equal(cashierOrd.status, 200);
      const cashierOrdJson = (await cashierOrd.json()) as { prescriptionUrl: string | null };
      assert.equal(cashierOrdJson.prescriptionUrl, null);

      // Pharmacist (has prescriptions.review) -> 200 OK with strict attachment + sandbox + nosniff + no-store headers
      const pharmRx = await fetch(`${APP}${canonicalPath}`, { headers: { Cookie: pharmacistCookie } });
      assert.equal(pharmRx.status, 200);
      assert.equal(pharmRx.headers.get("content-type"), "application/pdf");
      assert.equal(pharmRx.headers.get("x-content-type-options"), "nosniff");
      assert.match(pharmRx.headers.get("content-disposition") ?? "", /^attachment;/);
      assert.match(pharmRx.headers.get("content-security-policy") ?? "", /sandbox/);
      assert.match(pharmRx.headers.get("cache-control") ?? "", /no-store/);

      // Owning customer -> 200 OK
      const custRx = await fetch(`${APP}${canonicalPath}`, { headers: { Cookie: customerCookie } });
      assert.equal(custRx.status, 200);

      // Customer-owned order rejects unauthenticated guest HMAC tokens (guest tokens only unlock guest orders)
      const tok = orderAccessToken(ord.id);
      const custWithGuestTok = await fetch(`${APP}${canonicalPath}?orderId=${ord.id}&token=${tok}`);
      assert.equal(custWithGuestTok.status, 403);
      const badGuest = await fetch(`${APP}${canonicalPath}?orderId=${ord.id}&token=invalidtoken12345678901234567890`);
      assert.equal(badGuest.status, 403);

      } finally {
        await cancelOrder(ord.id, null, "HTTP upload test cleanup", { system: true }).catch(() => {});
        await prisma.order.delete({ where: { id: ord.id } }).catch(() => {});
      }
    }

    for (const c of [cashierCookie, pharmacistCookie, customerCookie]) {
      await fetch(`${APP}/api/auth/logout`, { method: "POST", headers: { Origin: APP, Cookie: c } });
    }
  });
});

after(async () => {
  for (const p of cleanupPaths) {
    await unlink(p).catch(() => {});
  }
  await prisma.$disconnect();
});
