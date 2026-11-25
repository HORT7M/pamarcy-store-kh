import "server-only";
export { getAuthSecret } from "@/lib/env";

/**
 * Extract client IP without trusting spoofable forwarding headers unless TRUST_PROXY=1
 * (or platform-verified x-vercel-forwarded-for is present).
 */
export function trustedClientIp(h: Headers): string {
  const vercelIp = h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercelIp) return vercelIp;
  if (process.env.TRUST_PROXY === "1") {
    const realIp = h.get("x-real-ip")?.trim();
    if (realIp) return realIp;
    const xff = h.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return "local";
}
