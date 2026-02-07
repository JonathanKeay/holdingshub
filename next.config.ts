import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avoid Next 15 turbopack warnings; keep using webpack
  turbopack: {},
  // Standalone output for smaller Docker runtime
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'logo.clearbit.com' },
    ],
  },
  // Note: experimental options removed to avoid Next config warnings

  webpack(config) {
    // Exclude .svg from Next.js default image loader
    (config.module.rules as Array<unknown>)
      .filter((rule): rule is { test?: RegExp; exclude?: RegExp } => {
        const r = rule as { test?: RegExp };
        return !!r?.test?.test?.('.svg');
      })
      .forEach((rule) => { (rule as { exclude?: RegExp }).exclude = /\.svg$/i; });

    // Add SVGR loader so .svg imports become React components
    (config.module.rules as Array<unknown>).push({
      test: /\.svg$/i,
      issuer: /\.[jt]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
};

export default nextConfig;
