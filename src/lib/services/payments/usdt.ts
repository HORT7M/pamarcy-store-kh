import "server-only";
import { createHash } from "node:crypto";
import { USDT_NETWORK_META, type UsdtNetworkCode, type UsdtNetworkConfig } from "./config";
import { ApiError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";

/**
 * USDT-only on-chain verification.
 * For every submitted tx hash we independently verify on the configured chain:
 *   1. tx exists and succeeded           4. token contract == configured USDT contract
 *   2. correct network (chainId / TRON)  5. transferred amount == exact expected amount
 *   3. recipient == our wallet           6. enough confirmations, and mined after the payment was created
 * Duplicate hash use is prevented by the UsedTransactionHash unique index (caller).
 */

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type VerifyResult =
  | { ok: true; amountUnits: bigint; confirmations: number; from: string; blockTime: Date; raw: unknown }
  | { ok: false; pending?: boolean; reason: string; raw?: unknown };

// ───────────── helpers ─────────────

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const lead = s.match(/^1*/)![0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
}

/** TRON base58check address → 20-byte lowercase hex (without 0x41 prefix). */
export function tronToHex20(addr: string): string {
  const raw = base58Decode(addr);
  if (raw.length !== 25) throw new Error("Invalid TRON address length");
  const payload = raw.subarray(0, 21);
  const checksum = raw.subarray(21);
  const h = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest();
  if (!h.subarray(0, 4).equals(checksum)) throw new Error("Invalid TRON address checksum");
  if (payload[0] !== 0x41) throw new Error("Not a TRON mainnet address");
  return payload.subarray(1).toString("hex");
}

export function isValidAddress(network: UsdtNetworkCode, addr: string): boolean {
  if (USDT_NETWORK_META[network].chain === "tron") {
    try {
      tronToHex20(addr);
      return true;
    } catch {
      return false;
    }
  }
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export function isValidTxHash(network: UsdtNetworkCode, h: string): boolean {
  return USDT_NETWORK_META[network].chain === "tron" ? /^[0-9a-fA-F]{64}$/.test(h) : /^0x[0-9a-fA-F]{64}$/.test(h);
}

export function normalizeTxHash(network: UsdtNetworkCode, h: string): string {
  const t = h.trim();
  return USDT_NETWORK_META[network].chain === "tron" ? t.replace(/^0x/i, "").toLowerCase() : (t.startsWith("0x") ? t : "0x" + t).toLowerCase();
}

/** Decimal string → token base units. e.g. ("12.5034", 6) → 12503400n */
export function toUnits(amount: string, decimals: number): bigint {
  const [i, f = ""] = amount.split(".");
  if (f.length > decimals) throw new Error("Too many decimals");
  return BigInt(i + f.padEnd(decimals, "0"));
}

export function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

const pad20 = (topic: string) => topic.replace(/^0x/, "").slice(-40).toLowerCase();

// ───────────── TRON (TRC-20) via TronGrid ─────────────

async function tron<T>(path: string, body?: unknown): Promise<T> {
  const base = serverEnv.trongrid.apiBase;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serverEnv.trongrid.apiKey) headers["TRON-PRO-API-KEY"] = serverEnv.trongrid.apiKey;
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  if (!res || !res.ok) throw new ApiError(502, "CHAIN_UPSTREAM", `TronGrid error ${res?.status}`);
  return res.json() as Promise<T>;
}

async function verifyTron(cfg: UsdtNetworkConfig, txHash: string, expectedUnits: bigint, notBefore: Date): Promise<VerifyResult> {
  type Info = {
    id?: string;
    blockNumber?: number;
    blockTimeStamp?: number;
    contract_address?: string;
    receipt?: { result?: string };
    result?: string;
    log?: { address: string; topics: string[]; data: string }[];
  };
  const info = await tron<Info>("/wallet/gettransactioninfobyid", { value: txHash });
  if (!info || !info.id) return { ok: false, pending: true, reason: "Transaction not found on TRON yet" };
  if (info.result === "FAILED" || (info.receipt?.result && info.receipt.result !== "SUCCESS")) {
    return { ok: false, reason: `Transaction failed on-chain (${info.receipt?.result ?? info.result})`, raw: info };
  }
  const contractHex = tronToHex20(cfg.contractAddress);
  const walletHex = tronToHex20(cfg.walletAddress);
  let total = 0n;
  let from = "";
  for (const l of info.log ?? []) {
    if (l.address.toLowerCase().replace(/^41/, "").slice(-40) !== contractHex) continue;
    if (l.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (pad20(l.topics[2]) !== walletHex) continue;
    total += BigInt("0x" + (l.data || "0"));
    from = pad20(l.topics[1]);
  }
  if (total === 0n) return { ok: false, reason: "No USDT transfer to the store wallet found in this transaction (wrong token, contract or recipient)", raw: info };
  const blockTime = new Date(info.blockTimeStamp ?? 0);
  if (blockTime.getTime() < notBefore.getTime()) return { ok: false, reason: "Transaction was made before this payment was created", raw: info };
  if (total !== expectedUnits) {
    return { ok: false, reason: `Amount mismatch: received ${fromUnits(total, cfg.decimals)} USDT, expected ${fromUnits(expectedUnits, cfg.decimals)} USDT`, raw: info };
  }
  const now = await tron<{ block_header?: { raw_data?: { number?: number } } }>("/wallet/getnowblock");
  const head = now.block_header?.raw_data?.number ?? 0;
  const confirmations = Math.max(0, head - (info.blockNumber ?? head));
  if (confirmations < cfg.confirmations) {
    return { ok: false, pending: true, reason: `Waiting for confirmations (${confirmations}/${cfg.confirmations})`, raw: info };
  }
  return { ok: true, amountUnits: total, confirmations, from, blockTime, raw: { id: info.id, blockNumber: info.blockNumber } };
}

/** Scan recent incoming TRC-20 transfers to our wallet for an exact amount (auto-detection). */
async function findTron(cfg: UsdtNetworkConfig, expectedUnits: bigint, notBefore: Date): Promise<string | null> {
  type R = { data?: { transaction_id: string; to: string; value: string; block_timestamp: number; token_info?: { address?: string } }[] };
  const q = new URLSearchParams({ only_to: "true", limit: "50", contract_address: cfg.contractAddress, min_timestamp: String(notBefore.getTime()) });
  const r = await tron<R>(`/v1/accounts/${cfg.walletAddress}/transactions/trc20?${q}`);
  const hit = (r.data ?? []).find((t) => t.to === cfg.walletAddress && BigInt(t.value) === expectedUnits && t.token_info?.address === cfg.contractAddress);
  return hit?.transaction_id ?? null;
}

// ───────────── EVM (ERC-20 / BEP-20 / Polygon) via JSON-RPC ─────────────

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new ApiError(502, "CHAIN_UPSTREAM", `RPC error ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new ApiError(502, "CHAIN_UPSTREAM", j.error.message);
  return j.result as T;
}

function rpcUrl(code: UsdtNetworkCode): string {
  const env = USDT_NETWORK_META[code].envRpc;
  const url = env ? serverEnv.evmRpcUrl(env) : "";
  if (!url) throw new ApiError(503, "CHAIN_NOT_CONFIGURED", `RPC endpoint for ${code} is not configured`);
  return url;
}

async function verifyEvm(cfg: UsdtNetworkConfig, txHash: string, expectedUnits: bigint, notBefore: Date): Promise<VerifyResult> {
  const url = rpcUrl(cfg.code);
  const meta = USDT_NETWORK_META[cfg.code];
  const chainId = parseInt(await rpc<string>(url, "eth_chainId", []), 16);
  if (chainId !== meta.chainId) return { ok: false, reason: `RPC endpoint is on chain ${chainId}, expected ${meta.chainId}` };
  type Receipt = { status: string; blockNumber: string; logs: { address: string; topics: string[]; data: string }[]; from: string };
  const receipt = await rpc<Receipt | null>(url, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { ok: false, pending: true, reason: `Transaction not found on ${meta.label} yet` };
  if (receipt.status !== "0x1") return { ok: false, reason: "Transaction reverted on-chain", raw: receipt };
  const contract = cfg.contractAddress.toLowerCase();
  const wallet = cfg.walletAddress.toLowerCase().replace(/^0x/, "");
  let total = 0n;
  let from = "";
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== contract) continue;
    if (l.topics[0]?.toLowerCase().replace(/^0x/, "") !== TRANSFER_TOPIC) continue;
    if (pad20(l.topics[2] ?? "") !== wallet) continue;
    total += BigInt(l.data === "0x" ? 0 : l.data);
    from = "0x" + pad20(l.topics[1] ?? "");
  }
  if (total === 0n) return { ok: false, reason: "No USDT transfer to the store wallet found in this transaction (wrong token, contract or recipient)", raw: receipt };
  const block = await rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  const blockTime = new Date(parseInt(block.timestamp, 16) * 1000);
  if (blockTime.getTime() < notBefore.getTime()) return { ok: false, reason: "Transaction was made before this payment was created", raw: receipt };
  if (total !== expectedUnits) {
    return { ok: false, reason: `Amount mismatch: received ${fromUnits(total, cfg.decimals)} USDT, expected ${fromUnits(expectedUnits, cfg.decimals)} USDT`, raw: receipt };
  }
  const head = parseInt(await rpc<string>(url, "eth_blockNumber", []), 16);
  const confirmations = head - parseInt(receipt.blockNumber, 16) + 1;
  if (confirmations < cfg.confirmations) return { ok: false, pending: true, reason: `Waiting for confirmations (${confirmations}/${cfg.confirmations})`, raw: receipt };
  return { ok: true, amountUnits: total, confirmations, from, blockTime, raw: { blockNumber: receipt.blockNumber } };
}

async function findEvm(cfg: UsdtNetworkConfig, expectedUnits: bigint): Promise<string | null> {
  const url = rpcUrl(cfg.code);
  const head = parseInt(await rpc<string>(url, "eth_blockNumber", []), 16);
  const toTopic = "0x" + cfg.walletAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const logs = await rpc<{ transactionHash: string; data: string }[]>(url, "eth_getLogs", [
    { fromBlock: "0x" + Math.max(0, head - 2000).toString(16), toBlock: "latest", address: cfg.contractAddress, topics: ["0x" + TRANSFER_TOPIC, null, toTopic] },
  ]);
  return logs.find((l) => BigInt(l.data) === expectedUnits)?.transactionHash ?? null;
}

// ───────────── public API ─────────────

export async function verifyUsdtTransfer(cfg: UsdtNetworkConfig, txHash: string, expectedAmount: string, notBefore: Date): Promise<VerifyResult> {
  const units = toUnits(expectedAmount, cfg.decimals);
  return USDT_NETWORK_META[cfg.code].chain === "tron" ? verifyTron(cfg, txHash, units, notBefore) : verifyEvm(cfg, txHash, units, notBefore);
}

/** Try to auto-detect a matching incoming transfer (unique amount) without a submitted hash. */
export async function findUsdtTransfer(cfg: UsdtNetworkConfig, expectedAmount: string, notBefore: Date): Promise<string | null> {
  const units = toUnits(expectedAmount, cfg.decimals);
  return USDT_NETWORK_META[cfg.code].chain === "tron" ? findTron(cfg, units, notBefore) : findEvm(cfg, units);
}

/** Payment URI encoded into the QR. TRON wallets accept the bare address; EVM uses EIP-681 for the token transfer. */
export function usdtPaymentUri(cfg: UsdtNetworkConfig, amount: string): string {
  const meta = USDT_NETWORK_META[cfg.code];
  if (meta.chain === "tron") return cfg.walletAddress;
  const units = toUnits(amount, cfg.decimals).toString();
  return `ethereum:${cfg.contractAddress}@${meta.chainId}/transfer?address=${cfg.walletAddress}&uint256=${units}`;
}
