import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Build an 'experimental' object only in dev.
// We keep it untyped so tsc doesn't fail on prod builds.
const experimental: any = {};
if (isDev) {
  // Add every origin you use to access dev (IP and/or LAN domain)
  experimental.allowedDevOrigins = [
    "http://192.168.50.227",
    "https://holdingshub.lan.yourdomain",
  ];
}

const nextConfig: NextConfig = {
  // Avoid Next 15 turbopack warnings; keep using webpack
  turbopack: {},
  // Standalone output for smaller Docker runtime
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
  // only present in dev; empty in prod (so 'next build' won't error)
  experimental,

  webpack(config) {
    // Exclude .svg from Next.js default image loader
    config.module.rules
      .filter((rule: any) => rule.test?.test?.(".svg"))
      .forEach((rule: any) => (rule.exclude = /\.svg$/i));

    // Add SVGR loader so .svg imports become React components
    config.module.rules.push({
      test: /\.svg$/i,
      issuer: /\.[jt]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
};

export default nextConfig;
