/**
 * Environment configuration -- CommitteeApp
 *
 * Single, typed read of build-time environment variables. Nothing else
 * in the app should read `import.meta.env` directly -- import `env`
 * from here instead, so there is exactly one place that knows the
 * variable names and defaults.
 *
 * Phase 1 note: only the Supabase client foundation variables exist
 * today. No financial/RPC-specific configuration is defined yet --
 * that is out of scope until the phase that introduces the financial
 * schema and RPC layer.
 */

export interface AppEnvironment {
  /** Supabase project URL (public). */
  readonly supabaseUrl: string
  /** Supabase anonymous/public API key (public). */
  readonly supabaseAnonKey: string
  /** Vite mode, e.g. "development", "production", "test". */
  readonly mode: string
  /** True when both Supabase variables are present and non-empty. */
  readonly isSupabaseConfigured: boolean
}

function readEnv(): AppEnvironment {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''
  const mode = import.meta.env.MODE

  const isSupabaseConfigured =
    supabaseUrl.length > 0 && supabaseAnonKey.length > 0

  if (!isSupabaseConfigured && mode !== 'test') {
    // Intentionally a warning, not a thrown error: Phase 1 ships an
    // application shell that must run, build and test cleanly even
    // before a real Supabase project is provisioned. Later phases that
    // actually need a live connection should check
    // `env.isSupabaseConfigured` themselves before calling out.
    console.warn(
      '[CommitteeApp] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. ' +
        'See .env.example and docs/DEVELOPMENT.md.',
    )
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    mode,
    isSupabaseConfigured,
  }
}

export const env: AppEnvironment = readEnv()
