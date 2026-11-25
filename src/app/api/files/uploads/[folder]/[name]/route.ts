import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api";
import { buildSafeFileHeaders, readStoredPublicImage } from "@/lib/upload";

/**
 * GET /api/files/uploads/:folder/:name
 * Serves verified public product/category/banner raster images stored outside /public
 * with strict magic-byte re-verification and non-executable sandbox headers.
 */
export const GET = apiHandler<{ folder: string; name: string }>(
  async (_req, { params }) => {
    const { folder, name } = await params;
    const file = await readStoredPublicImage(folder, name);
    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: buildSafeFileHeaders(file.mime, name, "public"),
    });
  },
  { rateLimit: { limit: 300, windowMs: 60_000, keyPrefix: "public-uploads" } },
);
