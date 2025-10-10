import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avoid Next 15 turbopack warnings; keep using webpack
  turbopack: {},
  // Standalone output for smaller Docker runtime
  output: 'standalone',
  webpack(config) {
    // Exclude .svg from Next.js default image loader
    config.module.rules
      .filter((rule: any) => rule.test?.test?.('.svg'))
      .forEach((rule: any) => (rule.exclude = /\.svg$/i));

    // Add SVGR loader so .svg imports become React components
    config.module.rules.push({
      test: /\.svg$/i,
      issuer: /\.[jt]sx?$/,
      use: ['@svgr/webpack'],
    });
    return config;
  },
};

export default nextConfig;
