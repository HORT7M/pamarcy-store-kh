// Calls /api/cron/maintenance once (or every N seconds with --loop).
import { existsSync } from "node:fs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const url = `${process.env.APP_URL || "http://localhost:3000"}/api/cron/maintenance`;
const secret = process.env.CRON_SECRET?.trim() || "";
if (!secret) {
  console.error("CRON_SECRET is not set in .env");
  process.exit(1);
}
const loop = process.argv.includes("--loop");

async function tick() {
  const res = await fetch(url, { method: "POST", headers: { "x-cron-secret": secret } });
  console.log(new Date().toISOString(), res.status, await res.text());
}

await tick();
if (loop) setInterval(() => tick().catch((e) => console.error(e.message)), 60_000);
