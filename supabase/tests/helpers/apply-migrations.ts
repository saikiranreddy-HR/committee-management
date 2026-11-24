import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'

/**
 * Phase 2A+ schema/RLS/RPC test harness.
 *
 * Applies every migration in supabase/migrations, in filename order,
 * to a fresh in-memory PostgreSQL instance (PGlite -- a real
 * WebAssembly build of PostgreSQL, not a mock). This is the closest
 * approximation available in this environment to "migrations apply
 * successfully to a clean database" without Docker/the Supabase CLI.
 *
 * IMPORTANT SCOPE NOTE: PGlite runs vanilla PostgreSQL. Real Supabase
 * projects come pre-provisioned with an `auth` schema, the
 * `anon`/`authenticated`/`service_role` Postgres roles, and
 * `auth.uid()`/`auth.role()` functions backed by GoTrue-issued,
 * PostgREST-validated JWTs -- our own migrations never create any of
 * that (doing so in a real migration would be actively dangerous: it
 * would either fail against a real project that already owns those
 * objects, or worse, silently shadow Supabase's real authentication).
 *
 * To let Phase 2D's RLS policies and the corrected financial RPC
 * apply and be tested at all, this test harness recreates the
 * externally-observable BEHAVIOR of that pre-provisioned layer --
 * the same three roles and the same `auth.uid()`/`auth.role()`
 * definitions Supabase itself documents and ships -- before applying
 * our own migrations, exactly mirroring the state a real Supabase
 * project is already in before migration 1 ever runs. This is not a
 * mock of RLS or of `auth.uid()`: once `request.jwt.claim.sub` is set
 * for a session and that session's role is switched to
 * `authenticated`, PostgreSQL enforces RLS and evaluates `auth.uid()`
 * exactly as it would in production -- the only thing not exercised
 * here is GoTrue's JWT issuance and PostgREST's JWT validation
 * (i.e. how a session legitimately comes to have a trustworthy
 * `request.jwt.claim.sub` in the first place). That boundary is
 * disclosed wherever it matters in the Phase 2D test files.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')

/**
 * Recreates the externally-observable behavior of Supabase's
 * pre-provisioned auth layer -- see the file-level doc comment above
 * for exactly what this does and does not faithfully reproduce.
 * Never shipped as a real migration; test-harness bootstrap only.
 */
const AUTH_SIMULATION_SQL = `
do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
    end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
    end if;
    if not exists (select from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
    end if;
end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Matches Supabase's real, documented auth.uid()/auth.role() exactly:
-- both read the PostgREST-populated 'request.jwt.claim.*' session GUCs.
create or replace function auth.uid() returns uuid
language sql stable
as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
`

function loadMigrationFiles(): { name: string; sql: string }[] {
  const fileNames = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  if (fileNames.length === 0) {
    throw new Error(`No migration files found in ${MIGRATIONS_DIR}`)
  }

  return fileNames.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
  }))
}

export interface MigratedDatabase {
  db: PGlite
  appliedMigrations: string[]
}

/**
 * Create a fresh in-memory PGlite instance, bootstrap the auth-layer
 * simulation described above, then apply every migration file in
 * order. Throws immediately, with the failing migration's filename,
 * if any migration does not apply cleanly.
 */
export async function createMigratedDatabase(): Promise<MigratedDatabase> {
  const db = new PGlite()
  await db.exec(AUTH_SIMULATION_SQL)

  const migrations = loadMigrationFiles()
  const appliedMigrations: string[] = []

  for (const migration of migrations) {
    try {
      await db.exec(migration.sql)
      appliedMigrations.push(migration.name)
    } catch (error) {
      throw new Error(
        `Migration "${migration.name}" failed to apply: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  return { db, appliedMigrations }
}

export function listMigrationFileNames(): string[] {
  return loadMigrationFiles().map((m) => m.name)
}

/**
 * Sets the current PGlite session's simulated auth context to the
 * given user id and switches the session role to `authenticated`,
 * exactly matching the state a PostgREST request would already be in
 * once it has validated an incoming JWT. Pass `null` to simulate an
 * unauthenticated (`anon`) request instead.
 */
export async function setAuthContext(
  db: PGlite,
  userId: string | null,
): Promise<void> {
  if (userId === null) {
    await db.exec(`reset role;`)
    await db.exec(`select set_config('request.jwt.claim.sub', '', false);`)
    await db.exec(`set role anon;`)
    return
  }

  await db.exec(`reset role;`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false);`, [
    userId,
  ])
  await db.exec(`set role authenticated;`)
}

/** Restores the session to its default (superuser-equivalent, RLS-bypassing) role -- test setup/teardown only. */
export async function clearAuthContext(db: PGlite): Promise<void> {
  await db.exec(`reset role;`)
  await db.exec(`select set_config('request.jwt.claim.sub', '', false);`)
}
