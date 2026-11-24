import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('getSupabaseClient', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('../../config/env')
  })

  it('throws a clear, actionable error when Supabase is not configured', async () => {
    vi.doMock('../../config/env', () => ({
      env: {
        supabaseUrl: '',
        supabaseAnonKey: '',
        mode: 'test',
        isSupabaseConfigured: false,
      },
    }))

    const { getSupabaseClient } = await import('./client')

    expect(() => getSupabaseClient()).toThrow(/not configured/i)
  })

  it('returns a usable client when Supabase is configured', async () => {
    vi.doMock('../../config/env', () => ({
      env: {
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key',
        mode: 'test',
        isSupabaseConfigured: true,
      },
    }))

    const { getSupabaseClient } = await import('./client')
    const client = getSupabaseClient()

    expect(client).toBeTruthy()
    expect(typeof client.auth.getSession).toBe('function')
  })

  it('caches the client across repeated calls', async () => {
    vi.doMock('../../config/env', () => ({
      env: {
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key',
        mode: 'test',
        isSupabaseConfigured: true,
      },
    }))

    const { getSupabaseClient } = await import('./client')

    expect(getSupabaseClient()).toBe(getSupabaseClient())
  })
})
