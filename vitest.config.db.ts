/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// Separate test config for Phase 2A database/schema tests
// (supabase/tests/**). These run against PGlite (an embedded,
// WebAssembly build of real PostgreSQL) in a plain Node environment
// -- they do not need jsdom and are intentionally kept out of the
// main `vite.config.ts` test config, which is for React component
// tests. See docs/DEVELOPMENT.md.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['supabase/tests/**/*.test.ts'],
    // Schema tests spin up a real (embedded) PostgreSQL instance per
    // suite; give them more headroom than the default component-test
    // timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
