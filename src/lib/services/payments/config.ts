import "server-only";
import type { PaymentMethod, PaymentMethodCode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

export type KhqrConfig = {
  merchantName: string;
  merchantCity: string;
  /** Bakong account id shown to customers (non-secret). Falls back to env BAKONG_ACCOUNT_ID */
  accountId?: string;
  merchantType: "individual" | "merchant";
  merchantId?: string;
  acquiringBank?: string;
  mobileNumber?: string;
  currencies: ("USD" | "KHR")[];
  expiryMinutes: number;
};

export type UsdtNetworkCode = "TRC20" | "ERC20" | "BEP20" | "POLYGON";
export type EvmRpcEnvKey = "ETHEREUM_RPC_URL" | "BSC_RPC_URL" | "POLYGON_RPC_URL";

export type UsdtNetworkConfig = {
  code: UsdtNetworkCode;
  enabled: boolean;
  walletAddress: string;
  contractAddress: string;
  decimals: number;
  confirmations: number;
};

export type UsdtConfig = {
  networks: UsdtNetworkConfig[];
  expiryMinutes: number;
};

export type PaypalConfig = { brandName: string };
export type CashConfig = Record<string, never>;

export const USDT_NETWORK_META: Record<UsdtNetworkCode, { label: string; chain: string; chainId?: number; explorerTx: string; defaultContract: string; defaultDecimals: number; envRpc?: EvmRpcEnvKey }> = {
  TRC20: { label: "TRON (TRC-20)", chain: "tron", explorerTx: "https://tronscan.org/#/transaction/", defaultContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", defaultDecimals: 6 },
  ERC20: { label: "Ethereum (ERC-20)", chain: "evm", chainId: 1, explorerTx: "https://etherscan.io/tx/", defaultContract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", defaultDecimals: 6, envRpc: "ETHEREUM_RPC_URL" },
  BEP20: { label: "BNB Smart Chain (BEP-20)", chain: "evm", chainId: 56, explorerTx: "https://bscscan.com/tx/", defaultContract: "0x55d398326f99059fF775485246999027B3197955", defaultDecimals: 18, envRpc: "BSC_RPC_URL" },
  POLYGON: { label: "Polygon PoS", chain: "evm", chainId: 137, explorerTx: "https://polygonscan.com/tx/", defaultContract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", defaultDecimals: 6, envRpc: "POLYGON_RPC_URL" },
};

export function khqrCredentialsPresent() {
  return Boolean(serverEnv.bakong.apiToken);
}

export function paypalCredentialsPresent() {
  return serverEnv.paypal.configured;
}

/** A network is usable only when the admin configured wallet + contract AND a verification backend exists. */
export function usdtNetworkReady(n: UsdtNetworkConfig): boolean {
  if (!n.enabled || !n.walletAddress || !n.contractAddress || !n.decimals) return false;
  const meta = USDT_NETWORK_META[n.code];
  if (meta.chain === "evm") return Boolean(meta.envRpc && serverEnv.evmRpcUrl(meta.envRpc));
  return true; // TronGrid works without key (rate-limited); key recommended
}

export async function getMethod(code: PaymentMethodCode) {
  return prisma.paymentMethod.findUnique({ where: { code } });
}

export function khqrConfig(m: PaymentMethod): KhqrConfig {
  return { merchantName: "Pamarcy Store", merchantCity: "Phnom Penh", merchantType: "individual", currencies: ["USD", "KHR"], expiryMinutes: 15, ...(m.config as Partial<KhqrConfig>) };
}
export function usdtConfig(m: PaymentMethod): UsdtConfig {
  return { networks: [], expiryMinutes: 60, ...(m.config as Partial<UsdtConfig>) };
}

export type MethodAvailability = {
  code: PaymentMethodCode;
  nameEn: string;
  nameKm: string;
  ready: boolean;
  reason?: string;
  networks?: { code: UsdtNetworkCode; label: string }[];
  currencies?: string[];
};

/** Which methods can actually take money right now (enabled + configured + credentials present). */
export async function availableMethods(channel: "online" | "pos"): Promise<MethodAvailability[]> {
  const methods = await prisma.paymentMethod.findMany({ where: { enabled: true, [channel]: true }, orderBy: { sortOrder: "asc" } });
  return methods.map((m) => {
    const base = { code: m.code, nameEn: m.nameEn, nameKm: m.nameKm };
    if (m.code === "KHQR") {
      const c = khqrConfig(m);
      const acct = c.accountId || serverEnv.bakong.accountId;
      if (!acct) return { ...base, ready: false, reason: "Bakong account not configured" };
      if (!khqrCredentialsPresent()) return { ...base, ready: false, reason: "BAKONG_API_TOKEN missing – payments cannot be verified" };
      return { ...base, ready: true, currencies: c.currencies };
    }
    if (m.code === "USDT") {
      const nets = usdtConfig(m).networks.filter(usdtNetworkReady);
      if (!nets.length) return { ...base, ready: false, reason: "No USDT network fully configured" };
      return { ...base, ready: true, networks: nets.map((n) => ({ code: n.code, label: USDT_NETWORK_META[n.code].label })) };
    }
    if (m.code === "PAYPAL") {
      if (!paypalCredentialsPresent()) return { ...base, ready: false, reason: "PayPal credentials missing" };
      return { ...base, ready: true };
    }
    return { ...base, ready: true };
  });
}
