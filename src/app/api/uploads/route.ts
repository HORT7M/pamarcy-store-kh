import { NextResponse } from "next/server";
import { apiHandler, clientIp } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getCurrentUser, requireStaff } from "@/lib/auth/session";
import {
  isValidUploadFolder,
  readBoundedFormData,
  storeUpload,
  UPLOAD_POLICIES,
} from "@/lib/upload";
import { rateLimitHeaders, rateLimitMulti } from "@/lib/rate-limit";
import { formatWaitDuration } from "@/lib/auth/rate-limits";
import { badRequest, tooManyRequests } from "@/lib/errors";
import { recordGuestUploadSignal, verifyBotProtection } from "@/lib/security/bot-protection";

/**
 * POST /api/uploads (multipart/form-data: file, folder)
 * - folder=prescriptions: guest (bot-verified + rate-limited) or authenticated customer (JPG, PNG, WebP or PDF; max 5 MB)
 * - other folders: staff with corresponding RBAC permission (JPG, PNG or WebP; max 5 MB)
 */
export const POST = apiHandler(
  async (req) => {
    const ip = clientIp(req);

    // Pre-parse IP cap prevents unauthenticated spam against staff-only or invalid folders before buffering multipart payloads
    const preRl = rateLimitMulti([{ key: `uploads:pre:1m:${ip}`, limit: 40, windowMs: 60_000 }]);
    if (!preRl.ok) {
      throw tooManyRequests(
        `Too many upload requests. Please wait ${formatWaitDuration(preRl.retryAfter)} before trying again.`,
        preRl.retryAfter,
        { limit: preRl.limit, resetAt: preRl.resetAt },
      );
    }

    // Enforces multipart/form-data Content-Type, Content-Length cap, AND bounded streaming read (prevents chunked DoS)
    const form = await readBoundedFormData(req);

    const rawFolder = form.get("folder");
    if (typeof rawFolder !== "string" || !isValidUploadFolder(rawFolder.trim())) {
      throw badRequest("Invalid folder");
    }
    const folder = rawFolder.trim();
    if (!isValidUploadFolder(folder)) throw badRequest("Invalid folder");

    const files = form.getAll("file");
    if (files.length !== 1 || !(files[0] instanceof File)) {
      throw badRequest("Exactly one file must be uploaded");
    }
    const file = files[0];

    if (folder === "prescriptions") {
      const user = await getCurrentUser();
      const rl = rateLimitMulti(
        user
          ? [
              { key: `uploads:rx:auth:1m:${ip}`, limit: 10, windowMs: 60_000 },
              { key: `uploads:rx:auth:15m:${user.id}`, limit: 30, windowMs: 15 * 60_000 },
            ]
          : [
              { key: `uploads:rx:guest:1m:${ip}`, limit: 4, windowMs: 60_000 },
              { key: `uploads:rx:guest:15m:${ip}`, limit: 10, windowMs: 15 * 60_000 },
              { key: `uploads:rx:guest:1h:${ip}`, limit: 20, windowMs: 60 * 60_000 },
            ],
      );
      if (!rl.ok) {
        throw tooManyRequests(
          `Too many file uploads. Please wait ${formatWaitDuration(rl.retryAfter)} before trying again.`,
          rl.retryAfter,
          { limit: rl.limit, resetAt: rl.resetAt },
        );
      }

      // Server-side bot protection before reading/parsing/storing uploaded prescription
      await verifyBotProtection(req, {
        action: "prescription_upload",
        formData: form,
        authenticated: Boolean(user),
        userId: user?.id ?? null,
      });

      const stored = await storeUpload(file, "prescriptions", { actorUserId: user?.id ?? null });
      if (!user) recordGuestUploadSignal(ip);
      await audit(user?.id ?? null, "upload.create", "Upload", null, {
        folder,
        fileName: stored.fileName,
        mime: stored.mime,
        size: stored.size,
      });
      return NextResponse.json(stored, {
        headers: { ...rateLimitHeaders(rl), "Cache-Control": "no-store" },
      });
    }

    const perm = UPLOAD_POLICIES[folder].permission;
    const staff = await requireStaff(perm ?? undefined);
    const rl = rateLimitMulti([{ key: `uploads:staff:1m:${staff.id}`, limit: 25, windowMs: 60_000 }]);
    if (!rl.ok) {
      throw tooManyRequests("Too many uploads, please slow down.", rl.retryAfter);
    }

    const stored = await storeUpload(file, folder, { actorUserId: staff.id });
    await audit(staff.id, "upload.create", "Upload", null, {
      folder,
      fileName: stored.fileName,
      mime: stored.mime,
      size: stored.size,
    });
    return NextResponse.json(stored, {
      headers: { ...rateLimitHeaders(rl), "Cache-Control": "no-store" },
    });
  },
  { rateLimit: false },
);
