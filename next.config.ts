import type { NextConfig } from "next";
import { getNextConfigHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "res.cloudinary.com" },
      { protocol: "https", hostname: "upload.wikimedia.org" },
    ],
  },
  serverExternalPackages: ["bakong-khqr", "@prisma/client"],
  async headers() {
    return getNextConfigHeaders();
  },
};

export default nextConfig;
