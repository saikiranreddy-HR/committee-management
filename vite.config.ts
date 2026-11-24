/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
//
// ARCHITECTURE GUARDRAIL (see docs/ARCHITECTURE-GUARDRAILS.md):
// The PWA service worker configured here is for installability and static
// asset caching ONLY. It must never precache or serve financial API
// responses as if they were authoritative -- the app is online-first, and
// financial mutations always require a live round trip to Supabase.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        id: '/',
        name: 'CommitteeApp',
        short_name: 'CommitteeApp',
        description:
          'Committee financial accountability, project, Pooja, ritual, inventory and reporting application.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#7a3b12',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache only the built static app shell (JS/CSS/HTML/icons).
        // No API routes are configured here -- there is intentionally no
        // runtime caching of Supabase requests in Phase 1 or beyond,
        // consistent with the online-first, non-authoritative-cache model.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallbackDenylist: [/^\/(?:api|rest|auth|storage)\//],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    // Scoped to the app source tree only. Phase 2A added a separate
    // database/schema test suite under supabase/tests -- see
    // vitest.config.db.ts and `npm run test:db` -- which must not be
    // swept up by this (jsdom) config nor run twice.
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/shared/testing/setup-tests.ts'],
    css: true,
  },
})
