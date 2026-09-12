import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // These tests are pure Node/TypeScript and never import CSS. The repo's
  // root postcss.config.mjs is written for Next.js/Tailwind v4 and is not
  // compatible with Vite's default PostCSS loader, so it's overridden here
  // (empty) purely to stop Vite from auto-discovering and failing to parse
  // it — this does not touch or affect the real Next.js build in any way.
  css: {
    postcss: { plugins: [] },
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "src/*" path mapping, which Next.js
    // resolves natively but Vite/Vitest needs told about explicitly. Needed
    // now that a test imports a plain function out of a component file
    // under src/components that uses "@/..." imports internally.
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
