import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('env', () => {
  const originalWarn = console.warn

  beforeEach(() => {
    vi.resetModules()
    console.warn = vi.fn()
  })

  afterEach(() => {
    console.warn = originalWarn
    vi.unstubAllEnvs()
  })

  it('reports isSupabaseConfigured=false when both variables are unset', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    const { env } = await import('./env')

    expect(env.isSupabaseConfigured).toBe(false)
    expect(env.supabaseUrl).toBe('')
    expect(env.supabaseAnonKey).toBe('')
  })

  it('reports isSupabaseConfigured=false when only one variable is set', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    const { env } = await import('./env')

    expect(env.isSupabaseConfigured).toBe(false)
  })

  it('reports isSupabaseConfigured=true when both variables are set', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')

    const { env } = await import('./env')

    expect(env.isSupabaseConfigured).toBe(true)
    expect(env.supabaseUrl).toBe('https://example.supabase.co')
    expect(env.supabaseAnonKey).toBe('anon-key')
  })

  it('does not warn while running under test mode', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    await import('./env')

    // Vitest's import.meta.env.MODE is "test", and the module
    // intentionally suppresses its console.warn in that mode so the
    // test suite output stays clean.
    expect(console.warn).not.toHaveBeenCalled()
  })
})
