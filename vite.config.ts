// vitest/config re-exports Vite's defineConfig with the `test` block typed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the built bundle works from any host path, including a
  // GitHub Pages project subdirectory.
  base: './',
  build: {
    target: 'es2022',
    // The vendored engine lives in public/ and is copied verbatim; never inline
    // it as a data URI.
    assetsInlineLimit: 0,
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
