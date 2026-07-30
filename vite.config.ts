// vitest/config re-exports Vite's defineConfig with the `test` block typed.
import { defineConfig } from 'vitest/config';

// Stamped at build time so the running app can say which version it is. Without
// this, "did my fix actually reach the phone?" is unanswerable.
const BUILD_ID = new Date().toISOString().replace('T', ' ').slice(0, 16);

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  // Relative base so the built bundle works from any host path, including a
  // GitHub Pages project subdirectory.
  base: './',
  build: {
    target: 'es2022',
    // The vendored engine lives in public/ and is copied verbatim; never inline
    // it as a data URI.
    assetsInlineLimit: 0,
    // Drop Vite's module-preload polyfill: it is the only thing in our own
    // bundle that calls fetch(), and an app that ships every byte it will ever
    // need has nothing to preload. Keeps the offline audit honest.
    modulePreload: { polyfill: false },
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
