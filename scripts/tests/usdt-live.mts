// Live check of the TRC-20 verifier against a real mainnet USDT transfer.
import { createHash } from "node:crypto";
import { verifyUsdtTransfer, tronToHex20 } from "../../src/lib/services/payments/usdt.ts";

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function hexToTron(hex20: string) {
  const payload = Buffer.from("41" + hex20, "hex");
  const chk = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  let n = BigInt("0x" + Buffer.concat([payload, chk]).toString("hex"));
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
const tx = process.argv[2], to = process.argv[3], amount = process.argv[4];
const wallet = hexToTron(to);
console.log("wallet", wallet, tronToHex20(wallet) === to);
const cfg = { code: "TRC20" as const, enabled: true, walletAddress: wallet, contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, confirmations: 19 };
const nb = new Date(Date.now() - 86400000);
for (const [label, amt, c] of [["exact", amount, cfg], ["wrong amount", "1.00", cfg], ["wrong wallet", amount, { ...cfg, walletAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }]] as const) {
  await new Promise((r) => setTimeout(r, 1500));
  const r = await verifyUsdtTransfer(c, tx, amt, nb);
  console.log(label, "→", r.ok ? `OK confirmations=${r.confirmations}` : `REJECT: ${r.reason}`);
}
const r2 = await verifyUsdtTransfer(cfg, tx, amount, new Date());
console.log("created after tx →", r2.ok ? "OK" : `REJECT: ${r2.reason}`);
