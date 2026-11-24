import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { env } from '../../config/env'

/**
 * Supabase client foundation -- CommitteeApp
 *
 * ============================================================
 * ARCHITECTURE GUARDRAIL -- READ BEFORE USING THIS CLIENT
 * ============================================================
 * This client exists for Supabase Auth (sessions/login) and for
 * RLS-gated, non-financial reads only.
 *
 * It must NEVER be used to write financial data directly, e.g.:
 *
 *   supabase.from('transactions').insert(...)   // FORBIDDEN
 *   supabase.from('projects').update({ liquidity: 50000 })  // FORBIDDEN
 *
 * Every financial mutation must go through a server-side Financial RPC
 * (`supabase.rpc(...)`) once that layer exists -- there is no financial
 * schema or RPC in Phase 1. See docs/ARCHITECTURE-GUARDRAILS.md for the
 * full rule and rationale.
 * ============================================================
 *
 * The client is created lazily so that importing this module never
 * throws when Supabase credentials are not configured (e.g. in the
 * Phase 1 build/test environment, which has no live Supabase project).
 * Calling `getSupabaseClient()` without configuration throws a clear,
 * actionable error at the call site instead.
 */

let cachedClient: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient
  }

  if (!env.isSupabaseConfigured) {
    throw new Error(
      'Supabase is not configured: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
        'must be set. Copy .env.example to .env.local and fill in your project ' +
        'values (see docs/DEVELOPMENT.md).',
    )
  }

  cachedClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  })

  return cachedClient
}

/** Test-only: reset the cached client so tests can exercise both the
 *  configured and unconfigured code paths in isolation. */
export function __resetSupabaseClientForTests(): void {
  cachedClient = null
}
