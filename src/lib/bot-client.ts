import { FetchError } from "./fetcher";

export type ClientBotAction =
  | "login"
  | "admin_login"
  | "register"
  | "checkout"
  | "prescription_upload"
  | "promo_code"
  | "review"
  | "password_reset"
  | "password_reset_confirm";

export type ClientBotProvider = "builtin" | "turnstile" | "hcaptcha";
export type ClientChallengeMode = "silent" | "interactive" | "accessible";

export type ClientBotPayload = {
  provider?: ClientBotProvider;
  token?: string;
  nonce?: string;
  answer?: string;
  hp?: string;
};

export type ChallengeResponse =
  | {
      provider: "turnstile" | "hcaptcha";
      siteKey: string;
      action: ClientBotAction;
      mode: "managed";
      required: boolean;
      allowFallback: boolean;
    }
  | {
      provider: "builtin";
      action: ClientBotAction;
      mode: ClientChallengeMode;
      required: boolean;
      token?: string;
      difficulty?: number;
      salt?: string;
      expiresAt?: number;
      imageDataUri?: string;
      prompt?: string;
    };

/** Convert Khmer (០-៩) and full-width (０-９) digits to ASCII 0-9. */
export function normalizeDigits(raw: string): string {
  return raw
    .replace(/[\u17e0-\u17e9]/g, (ch) => String(ch.charCodeAt(0) - 0x17e0))
    .replace(/[\uff10-\uff19]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((bytes[fullBytes]! & mask) !== 0) return false;
  }
  return true;
}

// Pure-JS SHA-256 fallback for plain HTTP non-localhost origins where crypto.subtle is unavailable
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Fallback(data: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const len = data.length;
  const bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15]! >>> 7) | (w[i - 15]! << 25)) ^ ((w[i - 15]! >>> 18) | (w[i - 15]! << 14)) ^ (w[i - 15]! >>> 3);
      const s1 = ((w[i - 2]! >>> 17) | (w[i - 2]! << 15)) ^ ((w[i - 2]! >>> 19) | (w[i - 2]! << 13)) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false); outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false); outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false); outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false); outView.setUint32(28, h7, false);
  return out;
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
  }
  return sha256Fallback(bytes);
}

/**
 * Solve lightweight browser Proof-of-Work without blocking the main UI thread.
 * Typical solve time at difficulty 13 is ~15–60ms.
 */
export async function solveBrowserPow(salt: string, difficulty: number, signal?: AbortSignal): Promise<string> {
  if (difficulty <= 0) return "0";
  for (let n = 0; n < 2_000_000; n++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const nonce = n.toString(36);
    const hash = await sha256Bytes(`${salt}:${nonce}`);
    if (hasLeadingZeroBits(hash, difficulty)) return nonce;
    // Yield periodically to keep UI responsive on low-end mobile devices
    if ((n & 255) === 255) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error("Could not complete browser verification");
}

export type BotChallengeSignal = {
  required: boolean;
  mode?: ClientChallengeMode;
  refresh?: boolean;
};

/** Inspect an API FetchError to detect server-initiated CAPTCHA escalation or refresh requests. */
export function parseBotChallengeError(err: unknown): BotChallengeSignal {
  if (!(err instanceof FetchError)) return { required: false };
  const details = (err.details ?? {}) as { challengeRequired?: boolean; mode?: ClientChallengeMode; refresh?: boolean };
  if (err.code === "CAPTCHA_REQUIRED" || err.code === "CAPTCHA_INVALID" || details.challengeRequired) {
    return {
      required: true,
      mode: details.mode === "interactive" || details.mode === "accessible" || details.mode === "silent" ? details.mode : "interactive",
      refresh: Boolean(details.refresh || err.code === "CAPTCHA_INVALID"),
    };
  }
  return { required: false };
}
