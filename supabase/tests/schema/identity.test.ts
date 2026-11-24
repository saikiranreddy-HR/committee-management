import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'

/**
 * Phase 2A correction -- Issue 1 (users.id must not independently
 * generate a second identity) and Issue 2 (server_global_sequence
 * generation behavior). Both are exercised behaviorally against a
 * real, embedded PostgreSQL instance (PGlite), not merely inspected
 * via pg_catalog.
 */
describe('Phase 2A identity corrections', () => {
  let migrated: MigratedDatabase

  beforeEach(async () => {
    migrated = await createMigratedDatabase()
  })

  afterEach(async () => {
    await migrated.db.close()
  })

  describe('Issue 1: users.id no longer independently generates a UUID', () => {
    it('rejects inserting a user without an explicit id', async () => {
      await expect(
        migrated.db.query(
          `insert into users (username, display_name, created_at)
           values ('ravi', 'Ravi Kumar', now())`,
        ),
      ).rejects.toThrow()
    })

    it('accepts and preserves an explicitly supplied id (the Supabase Auth user id)', async () => {
      const suppliedId = '11111111-1111-4111-8111-111111111111'

      const result = await migrated.db.query<{ id: string }>(
        `insert into users (id, username, display_name, created_at)
         values ($1, 'ravi', 'Ravi Kumar', now())
         returning id`,
        [suppliedId],
      )

      expect(result.rows[0]?.id).toBe(suppliedId)
    })

    it('has no column default on users.id', async () => {
      const result = await migrated.db.query<{ column_default: string | null }>(
        `select column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = 'users' and column_name = 'id'`,
      )
      expect(result.rows[0]?.column_default).toBeNull()
    })
  })

  describe('Issue 2: audit_events.server_global_sequence generation behavior', () => {
    async function insertUserAndProject() {
      const user = await migrated.db.query<{ id: string }>(
        `insert into users (id, username, display_name, created_at)
         values (gen_random_uuid(), 'ravi', 'Ravi Kumar', now())
         returning id`,
      )
      const project = await migrated.db.query<{ id: string }>(
        `insert into projects (name, type, start_date, end_date, status, client_timestamp)
         values ('Ganesh Chaturthi', 'FESTIVAL', now(), now(), 'ACTIVE', now())
         returning id`,
      )
      return { userId: user.rows[0]!.id, projectId: project.rows[0]!.id }
    }

    it('is server-generated, non-null, and never client-supplied', async () => {
      const { userId, projectId } = await insertUserAndProject()

      // A client attempting to supply this value directly must fail,
      // proving the server -- not the client -- controls it.
      await expect(
        migrated.db.query(
          `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp, server_global_sequence)
           values ('projects', $1, 'CREATE', $2, 1, '{}'::jsonb, now(), 999)`,
          [projectId, userId],
        ),
      ).rejects.toThrow()
    })

    it('is non-null and strictly monotonically increasing across inserts', async () => {
      const { userId, projectId } = await insertUserAndProject()

      const first = await migrated.db.query<{
        server_global_sequence: string
      }>(
        `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp)
         values ('projects', $1, 'CREATE', $2, 1, '{}'::jsonb, now())
         returning server_global_sequence`,
        [projectId, userId],
      )
      const second = await migrated.db.query<{
        server_global_sequence: string
      }>(
        `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp)
         values ('projects', $1, 'UPDATE', $2, 2, '{}'::jsonb, now())
         returning server_global_sequence`,
        [projectId, userId],
      )

      const firstSeq = first.rows[0]?.server_global_sequence
      const secondSeq = second.rows[0]?.server_global_sequence

      expect(firstSeq).not.toBeNull()
      expect(secondSeq).not.toBeNull()
      expect(BigInt(secondSeq!)).toBeGreaterThan(BigInt(firstSeq!))
    })

    it('is declared NOT NULL in the schema', async () => {
      const result = await migrated.db.query<{ is_nullable: 'YES' | 'NO' }>(
        `select is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'audit_events'
            and column_name = 'server_global_sequence'`,
      )
      expect(result.rows[0]?.is_nullable).toBe('NO')
    })

    it('cannot be modified after insert (blocked twice over: by PostgreSQL identity-column semantics, and by the append-only trigger)', async () => {
      const { userId, projectId } = await insertUserAndProject()

      const inserted = await migrated.db.query<{ id: string }>(
        `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp)
         values ('projects', $1, 'CREATE', $2, 1, '{}'::jsonb, now())
         returning id`,
        [projectId, userId],
      )

      // PostgreSQL itself rejects a direct UPDATE of a `GENERATED
      // ALWAYS AS IDENTITY` column before any trigger even runs --
      // this is a stronger guarantee than the append-only trigger
      // alone. (The append-only trigger additionally blocks updating
      // any *other* column on this table -- see immutability.test.ts.)
      await expect(
        migrated.db.query(
          `update audit_events set server_global_sequence = 42 where id = $1`,
          [inserted.rows[0]!.id],
        ),
      ).rejects.toThrow(/can only be updated to DEFAULT/)
    })
  })
})
