import { defineConfig } from 'vitest/config';

export default defineConfig({
  // These tests are pure Node/TypeScript and never import CSS. The repo's
  // root postcss.config.mjs is written for Next.js/Tailwind v4 and is not
  // compatible with Vite's default PostCSS loader, so it's overridden here
  // (empty) purely to stop Vite from auto-discovering and failing to parse
  // it — this does not touch or affect the real Next.js build in any way.
  css: {
    postcss: { plugins: [] },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
