import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { v2 as cloudinary } from "cloudinary";
import type { Permission } from "./auth/permissions";
import { getAuthSecret, serverEnv } from "./env";
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from "./errors";
import { decryptBuffer, encryptBuffer, isEncryptedBuffer, isStrictEncryptionMode, MAX_ENCRYPTED_FILE_OVERHEAD } from "./crypto";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024; // 64 KiB multipart framing budget
export const MIN_UPLOAD_BYTES = 16;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 64_000_000;
const MAX_PDF_INFLATE_BYTES = 25 * 1024 * 1024;
const PRESCRIPTION_CLAIM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export const UPLOAD_POLICIES = {
  products: { maxBytes: MAX_UPLOAD_BYTES, allowPdf: false, visibility: "public", permission: "medicines.write" },
  categories: { maxBytes: MAX_UPLOAD_BYTES, allowPdf: false, visibility: "public", permission: "categories.write" },
  banners: { maxBytes: MAX_UPLOAD_BYTES, allowPdf: false, visibility: "public", permission: "discounts.write" },
  prescriptions: { maxBytes: MAX_UPLOAD_BYTES, allowPdf: true, visibility: "private", permission: null },
} as const satisfies Record<string, { maxBytes: number; allowPdf: boolean; visibility: "public" | "private"; permission: Permission | null }>;

export type UploadFolder = keyof typeof UPLOAD_POLICIES;
export type PublicUploadFolder = "products" | "categories" | "banners";
export type AllowedExt = "jpg" | "png" | "webp" | "pdf";
export type AllowedMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export type ValidatedUpload = {
  ext: AllowedExt;
  mime: AllowedMime;
  buffer: Buffer;
  size: number;
  width?: number;
  height?: number;
};

const EXT_TO_MIME: Record<AllowedExt, AllowedMime> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

const MIME_TO_EXT: Record<string, AllowedExt> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** Executable, script, active-content, archive and server-config extensions blocked anywhere in a filename. */
const BLOCKED_EXTENSIONS = new Set([
  "php", "php3", "php4", "php5", "php7", "php8", "phtml", "phar", "pht", "pgif", "inc",
  "exe", "dll", "so", "dylib", "bin", "run", "elf", "out", "app", "msi", "msp", "mst",
  "bat", "cmd", "com", "scr", "pif", "cpl", "gadget",
  "vbs", "vbe", "js", "jse", "mjs", "cjs", "ts", "tsx", "jsx", "wsf", "wsh", "ps1", "psm1", "psd1",
  "sh", "bash", "zsh", "ksh", "csh", "fish",
  "py", "pyc", "pyw", "rb", "pl", "pm", "cgi", "fcgi",
  "asp", "aspx", "ascx", "ashx", "asmx", "cer", "asa", "config",
  "jsp", "jspx", "jsw", "jsv", "jspf", "war", "jar", "class", "ear",
  "swf", "fla", "wasm",
  "html", "htm", "xhtml", "shtml", "mhtml", "svg", "svgz", "xml", "xsl", "xslt", "xsd", "dtd", "rss", "atom",
  "hta", "htc", "chm", "hlp", "inf", "ins", "isp", "lnk", "url", "reg", "scf", "sct", "shb", "shs",
  "docm", "xlsm", "pptm", "dotm", "xltm", "potm", "ppam", "sldm",
  "apk", "ipa", "deb", "rpm", "dmg", "iso", "img",
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz",
  "htaccess", "htpasswd", "env", "ini", "conf", "sql", "db", "sqlite",
]);

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_STORED_IMAGE_NAME_RE = /^[a-z0-9-]+\.(jpg|png|webp)$/;
const SAFE_STORED_RX_NAME_RE = /^[a-z0-9-]+\.(jpg|png|webp|pdf)$/;

// Precomputed IEEE 802.3 CRC32 table for PNG chunk integrity verification
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

export function isValidUploadFolder(folder: string): folder is UploadFolder {
  return Object.hasOwn(UPLOAD_POLICIES, folder);
}

export function isPublicUploadFolder(folder: string): folder is PublicUploadFolder {
  return folder === "products" || folder === "categories" || folder === "banners";
}

function allowedTypesMessage(allowPdf: boolean): string {
  return allowPdf ? "Only JPG, PNG, WebP or PDF files are allowed" : "Only JPG, PNG or WebP images are allowed";
}

function assertValidDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw badRequest("Invalid image dimensions");
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw badRequest(`Image dimensions exceed maximum allowed (${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}px, 64 MP)`);
  }
}

/** Scan metadata / text segments for embedded server-side or client-side executable/script markers. */
function containsEmbeddedCodeMarkers(segment: Uint8Array): boolean {
  const s = Buffer.from(segment).toString("latin1").toLowerCase();
  return (
    s.includes("<?php") ||
    s.includes("<?=") ||
    s.includes("<%") ||
    s.includes("<script") ||
    s.includes("<html") ||
    s.includes("<!doctype") ||
    s.includes("<svg") ||
    s.includes("<iframe") ||
    s.includes("javascript:")
  );
}

/** Reject binary buffers whose header matches known executables, scripts, archives, or markup. */
function assertNotExecutableSignature(buf: Buffer) {
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) throw unsupportedMedia("Executable files (PE/MZ) are not allowed");
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    throw unsupportedMedia("Executable files (ELF) are not allowed");
  }
  if (buf.length >= 4) {
    const magic32 = buf.readUInt32BE(0);
    if (
      magic32 === 0xfeedface ||
      magic32 === 0xfeedfacf ||
      magic32 === 0xcefaedfe ||
      magic32 === 0xcffaedfe ||
      magic32 === 0xcafebabe
    ) {
      throw unsupportedMedia("Executable or bytecode binaries are not allowed");
    }
    if (magic32 === 0x0061736d) throw unsupportedMedia("WebAssembly binaries are not allowed");
    if (magic32 === 0x504b0304 || magic32 === 0x504b0506 || magic32 === 0x504b0708) {
      throw unsupportedMedia("Archive / package files are not allowed");
    }
    if (magic32 === 0x52617221) throw unsupportedMedia("Archive files are not allowed");
  }
  if (buf.length >= 6 && buf.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
    throw unsupportedMedia("Archive files are not allowed");
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) throw unsupportedMedia("Compressed archive files are not allowed");
  if (buf.length >= 2 && buf[0] === 0x23 && buf[1] === 0x21) throw unsupportedMedia("Script files are not allowed");

  // Check leading text (skipping UTF-8 BOM and ASCII whitespace) for HTML/SVG/XML/PHP/script headers
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && i < 64 && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  const head = buf.subarray(i, Math.min(buf.length, i + 64)).toString("latin1").toLowerCase();
  if (
    head.startsWith("<?php") ||
    head.startsWith("<?=") ||
    head.startsWith("<%") ||
    head.startsWith("<script") ||
    head.startsWith("<html") ||
    head.startsWith("<!doctype") ||
    head.startsWith("<svg") ||
    head.startsWith("<?xml")
  ) {
    throw unsupportedMedia("Markup and script files are not allowed");
  }
}

/** Validate client-supplied filename and extract canonical allowed extension. */
export function validateFileName(rawName: string, allowPdf: boolean): AllowedExt {
  if (typeof rawName !== "string" || rawName.length === 0) throw badRequest("Filename is required");
  if (rawName.length > MAX_FILENAME_LENGTH) throw badRequest("Filename is too long");
  if (/[\x00-\x1f\x7f]/.test(rawName)) throw badRequest("Invalid characters in filename");
  if (rawName.includes("/") || rawName.includes("\\") || rawName.includes("..")) {
    throw badRequest("Path traversal sequences in filename are not allowed");
  }
  const trimmed = rawName.trim();
  if (trimmed.startsWith(".") || trimmed.endsWith(".") || (trimmed !== rawName && rawName.endsWith(" "))) {
    throw badRequest("Invalid filename format");
  }
  const parts = trimmed.split(".");
  if (parts.length < 2 || parts.some((p) => p.length === 0)) {
    throw unsupportedMedia(allowedTypesMessage(allowPdf));
  }
  const stem = parts[0]!;
  if (RESERVED_WINDOWS_NAMES.test(stem)) throw badRequest("Reserved filename is not allowed");

  // Block dangerous executable/script/active extensions anywhere in multi-dot filenames (e.g. shell.php.jpg)
  for (let idx = 1; idx < parts.length; idx++) {
    const extPart = parts[idx]!.toLowerCase();
    if (BLOCKED_EXTENSIONS.has(extPart)) {
      throw unsupportedMedia("Executable or active file extensions are not allowed");
    }
  }

  const finalExt = parts[parts.length - 1]!.toLowerCase();
  if (finalExt === "jpg" || finalExt === "jpeg") return "jpg";
  if (finalExt === "png") return "png";
  if (finalExt === "webp") return "webp";
  if (finalExt === "pdf" && allowPdf) return "pdf";
  throw unsupportedMedia(allowedTypesMessage(allowPdf));
}

/** Validate client-supplied MIME type against strict allowlist. */
export function validateMimeType(rawMime: string, allowPdf: boolean): AllowedExt {
  const normalized = (rawMime ?? "").trim().toLowerCase();
  const ext = Object.hasOwn(MIME_TO_EXT, normalized) ? MIME_TO_EXT[normalized] : undefined;
  if (!ext || (ext === "pdf" && !allowPdf)) {
    throw unsupportedMedia(allowedTypesMessage(allowPdf));
  }
  return ext;
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Deep structural validation & comment-stripping sanitization for JPEG images. */
function validateAndSanitizeJpeg(buf: Buffer): ValidatedUpload {
  if (buf.length < 32 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw unsupportedMedia("Invalid or corrupted JPEG file");
  }
  const cleanChunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let pos = 2;
  let hasSOF = false;
  let hasSOS = false;
  let hasEOI = false;
  let width = 0;
  let height = 0;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw unsupportedMedia("Corrupted JPEG marker structure");
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) throw unsupportedMedia("Truncated JPEG marker");
    const marker = buf[pos++]!;

    if (marker === 0x00 || marker === 0xd8) throw unsupportedMedia("Invalid JPEG marker");
    if (marker === 0xd9) {
      hasEOI = true;
      for (let t = pos; t < buf.length; t++) {
        if (buf[t] !== 0x00 && buf[t] !== 0xff) {
          throw unsupportedMedia("Trailing data after JPEG EOI is not allowed");
        }
      }
      cleanChunks.push(Buffer.from([0xff, 0xd9]));
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      cleanChunks.push(Buffer.from([0xff, marker]));
      continue;
    }

    if (pos + 2 > buf.length) throw unsupportedMedia("Truncated JPEG segment header");
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > buf.length) throw unsupportedMedia("Invalid JPEG segment length");

    const segPayload = buf.subarray(pos + 2, pos + segLen);
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (containsEmbeddedCodeMarkers(segPayload)) {
        throw unsupportedMedia("Embedded script or active content in JPEG metadata is not allowed");
      }
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segLen < 8) throw unsupportedMedia("Malformed JPEG SOF segment");
      height = buf.readUInt16BE(pos + 3);
      width = buf.readUInt16BE(pos + 5);
      assertValidDimensions(width, height);
      hasSOF = true;
    }

    const segEnd = pos + segLen;
    // Strip arbitrary user comment segments (0xFE COM); retain image & ICC/APP segments
    if (marker !== 0xfe) {
      cleanChunks.push(Buffer.from([0xff, marker]));
      cleanChunks.push(buf.subarray(pos, segEnd));
    }
    pos = segEnd;

    if (marker === 0xda) {
      if (!hasSOF) throw unsupportedMedia("Invalid JPEG scan order");
      hasSOS = true;
      const scanStart = pos;
      while (pos < buf.length) {
        if (buf[pos] !== 0xff) {
          pos++;
          continue;
        }
        let next = pos + 1;
        while (next < buf.length && buf[next] === 0xff) next++;
        if (next >= buf.length) throw unsupportedMedia("Truncated JPEG entropy scan");
        const nm = buf[next]!;
        if (nm === 0x00 || (nm >= 0xd0 && nm <= 0xd7)) {
          pos = next + 1;
          continue;
        }
        break;
      }
      cleanChunks.push(buf.subarray(scanStart, pos));
    }
  }

  if (!hasSOF || !hasSOS || !hasEOI) throw unsupportedMedia("Incomplete or truncated JPEG image");
  const sanitized = Buffer.concat(cleanChunks);
  return { ext: "jpg", mime: EXT_TO_MIME.jpg, buffer: sanitized, size: sanitized.byteLength, width, height };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_STRIPPED_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);
const PNG_VALID_COLOR_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/** Deep chunk + CRC32 validation and text-metadata stripping for PNG images. */
function validateAndSanitizePng(buf: Buffer): ValidatedUpload {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw unsupportedMedia("Invalid PNG signature");
  }
  const cleanChunks: Buffer[] = [PNG_SIG];
  let pos = 8;
  let chunkIndex = 0;
  let hasIDAT = false;
  let hasIEND = false;
  let width = 0;
  let height = 0;

  while (pos < buf.length) {
    if (pos + 12 > buf.length) throw unsupportedMedia("Truncated PNG chunk header");
    const len = buf.readUInt32BE(pos);
    if (len > MAX_UPLOAD_BYTES || pos + 12 + len > buf.length) {
      throw unsupportedMedia("Invalid PNG chunk length");
    }
    const typeBytes = buf.subarray(pos + 4, pos + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw unsupportedMedia("Invalid PNG chunk type");

    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(pos + 4, dataEnd));
    if (expectedCrc !== actualCrc) throw unsupportedMedia("Corrupted PNG chunk (CRC mismatch)");

    const chunkData = buf.subarray(dataStart, dataEnd);
    if (chunkIndex === 0) {
      if (type !== "IHDR" || len !== 13) throw unsupportedMedia("Missing or invalid PNG IHDR chunk");
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      assertValidDimensions(width, height);
      const bitDepth = chunkData[8]!;
      const colorType = chunkData[9]!;
      const allowedDepths = PNG_VALID_COLOR_DEPTHS[colorType];
      if (!allowedDepths || !allowedDepths.includes(bitDepth)) {
        throw unsupportedMedia("Invalid PNG color type or bit depth");
      }
      if (chunkData[10] !== 0 || chunkData[11] !== 0 || (chunkData[12] !== 0 && chunkData[12] !== 1)) {
        throw unsupportedMedia("Invalid PNG compression or interlace method");
      }
    } else if (type === "IHDR") {
      throw unsupportedMedia("Duplicate PNG IHDR chunk");
    }

    if (PNG_STRIPPED_TEXT_CHUNKS.has(type)) {
      if (containsEmbeddedCodeMarkers(chunkData)) {
        throw unsupportedMedia("Embedded script or active content in PNG metadata is not allowed");
      }
      if (type === "zTXt") {
        const nul = chunkData.indexOf(0);
        if (nul >= 0 && nul + 2 <= chunkData.length && chunkData[nul + 1] === 0) {
          try {
            const inflated = inflateSync(chunkData.subarray(nul + 2), { maxOutputLength: 64 * 1024 });
            if (containsEmbeddedCodeMarkers(inflated)) {
              throw unsupportedMedia("Embedded script in compressed PNG metadata is not allowed");
            }
          } catch (err) {
            if (err instanceof Error && "status" in err) throw err;
            throw unsupportedMedia("Malformed compressed PNG metadata");
          }
        }
      }
    }

    if (type === "IDAT") hasIDAT = true;

    const fullChunkEnd = dataEnd + 4;
    if (!PNG_STRIPPED_TEXT_CHUNKS.has(type)) {
      cleanChunks.push(buf.subarray(pos, fullChunkEnd));
    }
    pos = fullChunkEnd;
    chunkIndex++;

    if (type === "IEND") {
      if (len !== 0 || pos !== buf.length) {
        throw unsupportedMedia("Trailing data after PNG IEND is not allowed");
      }
      hasIEND = true;
      break;
    }
  }

  if (!hasIDAT || !hasIEND) throw unsupportedMedia("Incomplete PNG image");
  const sanitized = Buffer.concat(cleanChunks);
  return { ext: "png", mime: EXT_TO_MIME.png, buffer: sanitized, size: sanitized.byteLength, width, height };
}

/** Deep RIFF container & VP8/VP8L/VP8X validation plus EXIF/XMP metadata stripping for WebP images. */
function validateAndSanitizeWebp(buf: Buffer): ValidatedUpload {
  if (buf.length < 20 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw unsupportedMedia("Invalid WebP header");
  }
  const riffSize = buf.readUInt32LE(4);
  const expectedTotal = riffSize + 8 + (riffSize & 1);
  if (buf.length !== riffSize + 8 && !(riffSize & 1 && buf.length === expectedTotal && buf[buf.length - 1] === 0)) {
    throw unsupportedMedia("WebP container length mismatch or trailing data detected");
  }

  const riffEnd = Math.min(buf.length, riffSize + 8);
  const keptChunks: Buffer[] = [];
  let strippedMeta = false;
  let pos = 12;
  let chunkIndex = 0;
  let hasImageBitstream = false;
  let width = 0;
  let height = 0;

  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) throw unsupportedMedia("Truncated WebP subchunk header");
    const fourCC = buf.subarray(pos, pos + 4).toString("ascii");
    if (!/^[\x20-\x7e]{4}$/.test(fourCC)) throw unsupportedMedia("Invalid WebP subchunk identifier");
    const chunkSize = buf.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > riffEnd) throw unsupportedMedia("WebP subchunk exceeds container size");
    const payload = buf.subarray(dataStart, dataEnd);
    const nextPos = dataEnd + (chunkSize & 1);
    if (chunkSize & 1 && nextPos <= buf.length && buf[dataEnd] !== 0) {
      throw unsupportedMedia("Invalid WebP chunk padding byte");
    }

    if (chunkIndex === 0 && fourCC !== "VP8 " && fourCC !== "VP8L" && fourCC !== "VP8X") {
      throw unsupportedMedia("Invalid primary WebP chunk");
    }

    if (fourCC === "VP8 ") {
      if (chunkSize < 10) throw unsupportedMedia("Truncated VP8 bitstream");
      if ((payload[0]! & 1) !== 0 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) {
        throw unsupportedMedia("Invalid VP8 keyframe header");
      }
      const w = payload.readUInt16LE(6) & 0x3fff;
      const h = payload.readUInt16LE(8) & 0x3fff;
      assertValidDimensions(w, h);
      if (!width) {
        width = w;
        height = h;
      }
      hasImageBitstream = true;
      keptChunks.push(Buffer.from(buf.subarray(pos, Math.min(nextPos, buf.length))));
    } else if (fourCC === "VP8L") {
      if (chunkSize < 5 || payload[0] !== 0x2f) throw unsupportedMedia("Invalid VP8L bitstream header");
      const bits = payload.readUInt32LE(1);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >>> 14) & 0x3fff) + 1;
      assertValidDimensions(w, h);
      if (!width) {
        width = w;
        height = h;
      }
      hasImageBitstream = true;
      keptChunks.push(Buffer.from(buf.subarray(pos, Math.min(nextPos, buf.length))));
    } else if (fourCC === "VP8X") {
      if (chunkIndex !== 0 || chunkSize !== 10) throw unsupportedMedia("Malformed VP8X header");
      if ((payload[0]! & 0xc0) !== 0 || payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0) {
        throw unsupportedMedia("Invalid VP8X flags");
      }
      width = (payload[4]! | (payload[5]! << 8) | (payload[6]! << 16)) + 1;
      height = (payload[7]! | (payload[8]! << 8) | (payload[9]! << 16)) + 1;
      assertValidDimensions(width, height);
      const copy = Buffer.from(buf.subarray(pos, Math.min(nextPos, buf.length)));
      // Clear EXIF (0x08) and XMP (0x04) presence bits because those metadata chunks are stripped
      copy[8] = copy[8]! & ~(0x08 | 0x04);
      keptChunks.push(copy);
    } else if (fourCC === "EXIF" || fourCC === "XMP ") {
      if (containsEmbeddedCodeMarkers(payload)) {
        throw unsupportedMedia("Embedded script or active content in WebP metadata is not allowed");
      }
      strippedMeta = true;
    } else {
      keptChunks.push(Buffer.from(buf.subarray(pos, Math.min(nextPos, buf.length))));
    }

    pos = nextPos;
    chunkIndex++;
  }

  if (!hasImageBitstream || width < 1 || height < 1) {
    throw unsupportedMedia("Incomplete WebP image");
  }

  if (!strippedMeta) {
    return { ext: "webp", mime: EXT_TO_MIME.webp, buffer: Buffer.from(buf), size: buf.byteLength, width, height };
  }

  const body = Buffer.concat(keptChunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.byteLength, 4);
  header.write("WEBP", 8, "ascii");
  const sanitized = Buffer.concat([header, body]);
  return { ext: "webp", mime: EXT_TO_MIME.webp, buffer: sanitized, size: sanitized.byteLength, width, height };
}

/** Dangerous PDF dictionary Name keys (post-#XX hex decoding) blocked in prescription PDFs. */
const BLOCKED_PDF_NAMES = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "AA",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
  "Flash",
  "XFA",
  "SubmitForm",
  "ImportData",
  "GoToE",
  "GoToR",
  "Movie",
  "Sound",
  "Rendition",
]);

function decodePdfName(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function assertSafePdfSyntax(pdfSyntaxText: string) {
  const lower = pdfSyntaxText.toLowerCase();
  if (lower.includes("<?php") || lower.includes("<?=") || lower.includes("<script") || lower.includes("<svg")) {
    throw unsupportedMedia("Embedded script or markup in PDF is not allowed");
  }
  const nameRegex = /\/([^\s/<>\[\]()%]+)/g;
  let match: RegExpExecArray | null;
  while ((match = nameRegex.exec(pdfSyntaxText)) !== null) {
    const decoded = decodePdfName(match[1]!);
    if (BLOCKED_PDF_NAMES.has(decoded)) {
      throw unsupportedMedia(`Active or executable PDF content (/${decoded}) is not allowed`);
    }
    // Allow benign page-fit OpenAction array destinations (e.g. `/OpenAction [3 0 R /FitH null]`),
    // but block action dictionaries (`/OpenAction << ... >>`) or indirect action objects (`/OpenAction 5 0 R`).
    if (decoded === "OpenAction") {
      const rest = pdfSyntaxText.slice(match.index + match[0].length).trimStart();
      if (!rest.startsWith("[")) {
        throw unsupportedMedia("Active PDF /OpenAction is not allowed");
      }
    }
  }
}

/** Deep header, trailer, decompression-bomb and active-content validation for PDF documents. */
function validatePdf(buf: Buffer): ValidatedUpload {
  if (buf.length < 64) throw unsupportedMedia("Invalid or truncated PDF file");
  const head = buf.subarray(0, 16).toString("latin1");
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(head)) {
    throw unsupportedMedia("Invalid PDF version header");
  }

  const tailWindow = buf.subarray(Math.max(0, buf.length - 1024)).toString("latin1");
  const eofIdx = tailWindow.lastIndexOf("%%EOF");
  if (eofIdx === -1) throw unsupportedMedia("Invalid PDF file (missing %%EOF trailer)");
  const afterEof = tailWindow.slice(eofIdx + 5);
  if (!/^[\r\n\t ]*$/.test(afterEof)) {
    throw unsupportedMedia("Trailing data after PDF %%EOF is not allowed");
  }

  // Separate non-stream PDF object syntax from binary stream payloads, and inspect compressed streams
  const raw = buf.toString("latin1");
  const nonStreamParts: string[] = [];
  let cursor = 0;
  let totalInflated = 0;

  while (cursor < raw.length) {
    const streamMatch = /stream(?:\r\n|\n)/.exec(raw.slice(cursor));
    if (!streamMatch) {
      nonStreamParts.push(raw.slice(cursor));
      break;
    }
    const dictPart = raw.slice(cursor, cursor + streamMatch.index);
    nonStreamParts.push(dictPart);

    const dataStart = cursor + streamMatch.index + streamMatch[0].length;
    const endIdx = raw.indexOf("endstream", dataStart);
    if (endIdx === -1) throw unsupportedMedia("Malformed PDF stream (missing endstream)");

    // Trim trailing EOL before endstream
    let dataEnd = endIdx;
    if (raw[dataEnd - 2] === "\r" && raw[dataEnd - 1] === "\n") dataEnd -= 2;
    else if (raw[dataEnd - 1] === "\n" || raw[dataEnd - 1] === "\r") dataEnd -= 1;

    // Inspect recent object header to see if FlateDecode or ObjStm is used
    const headerContext = dictPart.slice(Math.max(0, dictPart.lastIndexOf("<<")));
    const decodedHeader = decodePdfName(headerContext);
    const isFlate = /\/FlateDecode\b/.test(decodedHeader);
    const isObjStm = /\/ObjStm\b/.test(decodedHeader);

    if (isFlate && dataEnd > dataStart) {
      const remainingBudget = MAX_PDF_INFLATE_BYTES - totalInflated;
      if (remainingBudget <= 0) throw unsupportedMedia("PDF decompression limit exceeded");
      try {
        const inflated = inflateSync(buf.subarray(dataStart, dataEnd), { maxOutputLength: remainingBudget });
        totalInflated += inflated.byteLength;
        if (isObjStm) {
          nonStreamParts.push(inflated.toString("latin1"));
        }
      } catch (err) {
        if (err instanceof Error && "status" in err) throw err;
        throw unsupportedMedia("Corrupted or oversized compressed PDF stream");
      }
    } else if (isObjStm) {
      nonStreamParts.push(raw.slice(dataStart, dataEnd));
    }

    cursor = endIdx + "endstream".length;
  }

  assertSafePdfSyntax(nonStreamParts.join("\n"));
  return { ext: "pdf", mime: EXT_TO_MIME.pdf, buffer: Buffer.from(buf), size: buf.byteLength };
}

/** Detect, structurally validate and sanitize a file buffer from magic bytes alone. */
export function inspectFileBuffer(buf: Buffer, allowPdf = false): ValidatedUpload {
  if (!Buffer.isBuffer(buf) || buf.byteLength === 0) throw badRequest("Uploaded file is empty");
  if (buf.byteLength < MIN_UPLOAD_BYTES) throw badRequest("Uploaded file is too small or truncated");
  if (buf.byteLength > MAX_UPLOAD_BYTES) throw payloadTooLarge("File too large (max 5 MB)");

  assertNotExecutableSignature(buf);

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return validateAndSanitizeJpeg(buf);
  if (buf.subarray(0, 8).equals(PNG_SIG)) return validateAndSanitizePng(buf);
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return validateAndSanitizeWebp(buf);
  }
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-") {
    if (!allowPdf) throw unsupportedMedia(allowedTypesMessage(false));
    return validatePdf(buf);
  }

  throw unsupportedMedia(allowedTypesMessage(allowPdf));
}

/**
 * Validate a browser/multipart File across all layers:
 * 1) Size bounds (pre-read and post-read)
 * 2) Safe filename & extension allowlist + executable/double-extension blocklist
 * 3) Client MIME type allowlist
 * 4) Binary magic signature, container structure, dimensions, active-content blocklist & sanitization
 * 5) Cross-layer consistency (extension === MIME === binary signature)
 */
export async function validateUploadFile(file: File, allowPdf = false): Promise<ValidatedUpload> {
  if (!(file instanceof File)) throw badRequest("No file uploaded");
  if (file.size <= 0) throw badRequest("Uploaded file is empty");
  if (file.size < MIN_UPLOAD_BYTES) throw badRequest("Uploaded file is too small or truncated");
  if (file.size > MAX_UPLOAD_BYTES) throw payloadTooLarge("File too large (max 5 MB)");

  const extFromName = validateFileName(file.name, allowPdf);
  const extFromMime = validateMimeType(file.type, allowPdf);
  if (extFromName !== extFromMime) {
    throw unsupportedMedia(`File extension (.${extFromName}) does not match declared MIME type (${file.type})`);
  }

  const rawBuf = Buffer.from(await file.arrayBuffer());
  if (rawBuf.byteLength !== file.size) throw badRequest("Uploaded file size mismatch");

  const inspected = inspectFileBuffer(rawBuf, allowPdf);
  if (inspected.ext !== extFromName) {
    throw unsupportedMedia(`File content signature (.${inspected.ext}) does not match file extension (.${extFromName})`);
  }

  return inspected;
}

/**
 * Parse a `multipart/form-data` request while enforcing a strict maximum request body size
 * BEFORE buffering the full payload in memory (protects against chunked / oversized DoS uploads).
 */
export async function readBoundedFormData(
  req: Request,
  maxBodyBytes = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
): Promise<FormData> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType)) {
    throw unsupportedMedia("Content-Type must be multipart/form-data");
  }

  const rawLen = req.headers.get("content-length");
  if (rawLen !== null) {
    const parsedLen = Number(rawLen);
    if (!Number.isFinite(parsedLen) || parsedLen < 0) throw badRequest("Invalid Content-Length header");
    if (parsedLen > maxBodyBytes) throw payloadTooLarge("File too large (max 5 MB)");
  }

  if (!req.body) throw badRequest("Empty upload request body");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel().catch(() => {});
          throw payloadTooLarge("File too large (max 5 MB)");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw badRequest("Empty upload request body");

  const bodyBuf = Buffer.concat(chunks, total);
  try {
    const boundedReq = new Request(req.url, {
      method: req.method,
      headers: { "content-type": contentType },
      body: bodyBuf,
    });
    return await boundedReq.formData();
  } catch {
    throw badRequest("Malformed multipart/form-data upload");
  }
}

// ───────────────────── Prescription Claim Signing ─────────────────────

function computePrescriptionSig(fileName: string, actorKey: string, expMs: number): string {
  return createHmac("sha256", getAuthSecret())
    .update(`rx-claim:v1:${fileName}:${actorKey}:${expMs}`)
    .digest("base64url");
}

export function createPrescriptionClaimUrl(fileName: string, actorUserId: string | null, ttlMs = PRESCRIPTION_CLAIM_TTL_MS): string {
  if (!SAFE_STORED_RX_NAME_RE.test(fileName)) throw badRequest("Invalid prescription filename");
  const expMs = Date.now() + ttlMs;
  const actorKey = actorUserId ? `u:${actorUserId}` : "guest";
  const sig = computePrescriptionSig(fileName, actorKey, expMs);
  return `/api/files/prescriptions/${fileName}?claim=${expMs}.${sig}`;
}

/**
 * Verify a `?claim=` prescription upload URL presented at checkout and return its canonical
 * storage-backed path `/api/files/prescriptions/<name>` (with query token stripped).
 */
export async function verifyAndResolvePrescriptionClaim(rawUrl: string, actorUserId: string | null): Promise<{ fileName: string; canonicalUrl: string }> {
  const match = /^\/api\/files\/prescriptions\/([a-z0-9-]+\.(?:jpg|png|webp|pdf))\?claim=([0-9]{10,16})\.([A-Za-z0-9_-]{32,64})$/.exec(rawUrl);
  if (!match) throw badRequest("Invalid or untrusted prescription upload reference");
  const [, fileName, expStr, providedSig] = match as unknown as [string, string, string, string];
  const expMs = Number(expStr);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) {
    throw badRequest("Prescription upload session expired – please re-upload your prescription");
  }

  const actorKey = actorUserId ? `u:${actorUserId}` : "guest";
  const expectedSig = computePrescriptionSig(fileName, actorKey, expMs);
  const a = Buffer.from(expectedSig);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw badRequest("Prescription upload token is invalid or belongs to another session");
  }

  if (!serverEnv.cloudinary.configured) {
    const filePath = resolveConfinedPath(privatePrescriptionDir(), fileName);
    try {
      const st = await lstat(filePath);
      if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_UPLOAD_BYTES || st.size > MAX_UPLOAD_BYTES) {
        throw badRequest("Uploaded prescription file was not found");
      }
    } catch (err) {
      if (err instanceof Error && "status" in err) throw err;
      throw badRequest("Uploaded prescription file was not found");
    }
  }

  return { fileName, canonicalUrl: `/api/files/prescriptions/${fileName}` };
}

// ───────────────────── Safe Storage & Retrieval ─────────────────────

function configureCloudinary() {
  cloudinary.config({
    cloud_name: serverEnv.cloudinary.cloudName,
    api_key: serverEnv.cloudinary.apiKey,
    api_secret: serverEnv.cloudinary.apiSecret,
    secure: true,
  });
}

function privatePrescriptionDir(): string {
  return path.resolve("storage", "prescriptions");
}

function publicUploadDir(folder: PublicUploadFolder): string {
  return path.resolve("storage", "uploads", folder);
}

/** Confine `fileName` strictly inside `baseDir`, blocking traversal, null bytes, and subpaths. */
function resolveConfinedPath(baseDir: string, fileName: string): string {
  if (!fileName || fileName.includes("\0") || path.basename(fileName) !== fileName) {
    throw badRequest("Invalid stored filename");
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, fileName);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw badRequest("Path traversal blocked");
  }
  return resolvedTarget;
}

async function ensureSafeDirectory(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error("Upload storage directory is invalid or a symbolic link");
  }
}

export function buildSafeFileHeaders(
  mime: AllowedMime,
  fileName: string,
  visibility: "public" | "private",
): Record<string, string> {
  const safeName = fileName.replace(/[^a-z0-9.-]/gi, "");
  const isPdf = mime === "application/pdf";
  const base: Record<string, string> = {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Force download for PDFs to eliminate active-document execution in-browser; inline for validated raster images
    "Content-Disposition": `${isPdf ? "attachment" : "inline"}; filename="${safeName}"`,
  };
  if (visibility === "private") {
    base["Cache-Control"] = "private, no-store, no-cache, must-revalidate";
    base["Pragma"] = "no-cache";
    base["Referrer-Policy"] = "no-referrer";
  } else {
    base["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return base;
}

export async function storeUpload(
  file: File,
  folder: UploadFolder,
  opts: { actorUserId?: string | null } = {},
): Promise<{ url: string; fileName: string; ext: AllowedExt; mime: AllowedMime; size: number }> {
  if (!isValidUploadFolder(folder)) throw badRequest("Invalid upload folder");
  const policy = UPLOAD_POLICIES[folder];
  const validated = await validateUploadFile(file, policy.allowPdf);

  // Cryptographically random UUIDv4 – zero client filename characters ever enter storage paths
  const id = randomUUID();
  const fileName = `${id}.${validated.ext}`;

  // Encrypt confidential patient prescriptions with AES-256-GCM before persisting to cloud or disk
  const payloadToStore =
    folder === "prescriptions"
      ? encryptBuffer(validated.buffer, "file-rx", `prescription:${fileName}`)
      : validated.buffer;

  if (serverEnv.cloudinary.configured) {
    configureCloudinary();
    const isRx = folder === "prescriptions";
    const res = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `pamarcy/${folder}`,
          public_id: isRx ? `${id}.enc` : id,
          resource_type: isRx || validated.ext === "pdf" ? "raw" : "image",
          allowed_formats: isRx || validated.ext === "pdf" ? undefined : ["jpg", "png", "webp"],
          overwrite: false,
          invalidate: false,
          // Prescriptions contain encrypted PHI -> authenticated raw delivery only
          type: isRx ? "authenticated" : "upload",
        },
        (err, r) => (err || !r ? reject(err ?? new Error("Cloudinary upload failed")) : resolve(r as { secure_url: string })),
      );
      stream.end(payloadToStore);
    });

    const url = isRx
      ? createPrescriptionClaimUrl(fileName, opts.actorUserId ?? null)
      : res.secure_url;
    return { url, fileName, ext: validated.ext, mime: validated.mime, size: validated.size };
  }

  if (serverEnv.isProduction && !serverEnv.allowLocalUploads) {
    throw badRequest("File storage is not configured");
  }

  // Local storage: ALL uploads live outside /public with non-executable 0600 permissions and wx exclusive creation
  const dir = folder === "prescriptions" ? privatePrescriptionDir() : publicUploadDir(folder);
  await ensureSafeDirectory(dir);
  const targetPath = resolveConfinedPath(dir, fileName);
  await writeFile(targetPath, payloadToStore, { mode: 0o600, flag: "wx" });

  const url =
    folder === "prescriptions"
      ? createPrescriptionClaimUrl(fileName, opts.actorUserId ?? null)
      : `/api/files/uploads/${folder}/${fileName}`;

  return { url, fileName, ext: validated.ext, mime: validated.mime, size: validated.size };
}

function decryptStoredPrescriptionBytes(raw: Buffer, fileName: string): Buffer {
  if (isEncryptedBuffer(raw)) {
    try {
      return decryptBuffer(raw, "file-rx", `prescription:${fileName}`);
    } catch {
      throw unsupportedMedia("Stored prescription failed cryptographic integrity verification");
    }
  }
  if (isStrictEncryptionMode()) {
    throw unsupportedMedia("Unencrypted prescription file rejected");
  }
  return raw;
}

/** Read, decrypt, and re-verify a private prescription file from storage (or authenticated Cloudinary). */
export async function readStoredPrescription(fileName: string): Promise<{ buffer: Buffer; mime: AllowedMime; ext: AllowedExt }> {
  if (!SAFE_STORED_RX_NAME_RE.test(fileName) || path.basename(fileName) !== fileName) {
    throw notFound();
  }
  const expectedExt = fileName.split(".").pop() as AllowedExt;

  if (serverEnv.cloudinary.configured) {
    const baseId = fileName.replace(/\.[^.]+$/, "");
    configureCloudinary();
    const encryptedUrl = cloudinary.url(`pamarcy/prescriptions/${baseId}.enc`, {
      type: "authenticated",
      resource_type: "raw",
      sign_url: true,
      secure: true,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    let upstream = await fetch(encryptedUrl, { cache: "no-store" });
    if (!upstream.ok && !isStrictEncryptionMode()) {
      const legacyUrl = cloudinary.url(`pamarcy/prescriptions/${baseId}`, {
        type: "authenticated",
        resource_type: expectedExt === "pdf" ? "raw" : "image",
        format: expectedExt === "pdf" ? "pdf" : expectedExt,
        sign_url: true,
        secure: true,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      });
      upstream = await fetch(legacyUrl, { cache: "no-store" });
    }
    if (!upstream.ok) throw notFound();
    const rawBuf = Buffer.from(await upstream.arrayBuffer());
    const plainBuf = decryptStoredPrescriptionBytes(rawBuf, fileName);
    const verified = inspectFileBuffer(plainBuf, true);
    if (verified.ext !== expectedExt) throw notFound();
    return { buffer: verified.buffer, mime: verified.mime, ext: verified.ext };
  }

  const baseDir = privatePrescriptionDir();
  const filePath = resolveConfinedPath(baseDir, fileName);
  let st;
  try {
    st = await lstat(filePath);
  } catch {
    throw notFound();
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_UPLOAD_BYTES || st.size > MAX_UPLOAD_BYTES + MAX_ENCRYPTED_FILE_OVERHEAD) {
    throw notFound();
  }
  const rawBuf = await readFile(filePath);
  const plainBuf = decryptStoredPrescriptionBytes(rawBuf, fileName);
  const verified = inspectFileBuffer(plainBuf, true);
  if (verified.ext !== expectedExt) throw notFound();
  return { buffer: verified.buffer, mime: verified.mime, ext: verified.ext };
}

/** Read and re-verify a public catalogue upload stored outside /public. */
export async function readStoredPublicImage(folder: string, fileName: string): Promise<{ buffer: Buffer; mime: AllowedMime; ext: AllowedExt }> {
  if (!isPublicUploadFolder(folder)) throw notFound();
  if (!SAFE_STORED_IMAGE_NAME_RE.test(fileName) || path.basename(fileName) !== fileName) {
    throw notFound();
  }
  const expectedExt = fileName.split(".").pop() as AllowedExt;
  const baseDir = publicUploadDir(folder);
  const filePath = resolveConfinedPath(baseDir, fileName);
  let st;
  try {
    st = await lstat(filePath);
  } catch {
    throw notFound();
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_UPLOAD_BYTES || st.size > MAX_UPLOAD_BYTES) {
    throw notFound();
  }
  const buf = await readFile(filePath);
  const verified = inspectFileBuffer(buf, false);
  if (verified.ext !== expectedExt) throw notFound();
  return { buffer: verified.buffer, mime: verified.mime, ext: verified.ext };
}

/** Remove abandoned local prescription files older than `maxAgeMs` that are not linked to any Order. */
export async function pruneOrphanPrescriptions(referencedUrls: Set<string>, maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const dir = privatePrescriptionDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    if (!SAFE_STORED_RX_NAME_RE.test(name)) continue;
    const canonicalUrl = `/api/files/prescriptions/${name}`;
    if (referencedUrls.has(canonicalUrl)) continue;
    try {
      const fp = resolveConfinedPath(dir, name);
      const st = await lstat(fp);
      if (st.isFile() && !st.isSymbolicLink() && st.mtimeMs < cutoff) {
        await unlink(fp);
        removed++;
      }
    } catch {
      /* ignore concurrent removal */
    }
  }
  return removed;
}
