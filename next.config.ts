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
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored:
          /^((?:[^/]*(?:\/|$))*)(\.(git|next|pgdata|logs|qa-shots)|node_modules|backups|storage)(\/((?:[^/]*(?:\/|$))*)(?:$|\/))?/,
      };
    }
    return config;
  },
  async headers() {
    return getNextConfigHeaders();
  },
};

export default nextConfig;
