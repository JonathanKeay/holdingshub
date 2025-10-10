/** @type {import('next').NextConfig} */
const nextConfig = {
  // 👇 Adding turbopack key avoids warnings in Next 15
  turbopack: {
    // leave empty → ensures Webpack is used
  },

  // Use standalone output so Docker images can run with minimal files
  output: 'standalone',

  webpack(config) {
    // Exclude .svg from Next.js default image loader
    config.module.rules
      .filter((rule) => rule.test?.test?.('.svg'))
      .forEach((rule) => (rule.exclude = /\.svg$/i));

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
