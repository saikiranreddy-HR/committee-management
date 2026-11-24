/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Public by design (see docs/DEVELOPMENT.md). */
  readonly VITE_SUPABASE_URL: string
  /** Supabase anonymous/public API key. Public by design; authorization
   *  is enforced by RLS + server-side Financial RPCs, never by keeping
   *  this key secret (see docs/ARCHITECTURE-GUARDRAILS.md). */
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
