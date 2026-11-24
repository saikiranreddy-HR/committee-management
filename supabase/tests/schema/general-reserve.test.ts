import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'

/**
 * Task requirement #9: "General Reserve structure exists as required."
 * Source: architecturefinal-v4.5.1.md §6 General Reserve Protection
 * Invariant, §13 Invariant 65.
 *
 * Each test gets a fresh migrated database (rather than sharing one
 * across the file) because these tests mutate rows, including
 * deliberately attempting invalid mutations.
 */
describe('Phase 2A General Reserve structural guardrails', () => {
  let migrated: MigratedDatabase

  beforeEach(async () => {
    migrated = await createMigratedDatabase()
  })

  afterEach(async () => {
    await migrated.db.close()
  })

  it('seeds exactly one General Reserve project', async () => {
    const result = await migrated.db.query<{ count: string }>(
      `select count(*)::text as count from projects where is_general_reserve = true`,
    )
    expect(result.rows[0]?.count).toBe('1')
  })

  it('seeds the General Reserve with the expected identity fields', async () => {
    const result = await migrated.db.query<{
      name: string
      type: string
      status: string
    }>(
      `select name, type, status from projects where is_general_reserve = true`,
    )
    expect(result.rows[0]).toEqual({
      name: 'General Reserve',
      type: 'GENERAL_RESERVE',
      status: 'ACTIVE',
    })
  })

  it('rejects creating a second General Reserve project', async () => {
    await expect(
      migrated.db.query(
        `insert into projects (name, type, start_date, end_date, status, is_general_reserve, client_timestamp)
         values ('Second Reserve', 'GENERAL_RESERVE', now(), now(), 'ACTIVE', true, now())`,
      ),
    ).rejects.toThrow()
  })

  it('rejects cloning FROM the General Reserve', async () => {
    const gr = await migrated.db.query<{ id: string }>(
      `select id from projects where is_general_reserve = true`,
    )
    const generalReserveId = gr.rows[0]?.id

    const ordinary = await migrated.db.query<{ id: string }>(
      `insert into projects (name, type, start_date, end_date, status, client_timestamp)
       values ('Ganesh Chaturthi', 'FESTIVAL', now(), now(), 'PLANNING', now())
       returning id`,
    )
    const ordinaryId = ordinary.rows[0]?.id

    await expect(
      migrated.db.query(
        `update projects set cloned_from_project_id = $1 where id = $2`,
        [generalReserveId, ordinaryId],
      ),
    ).rejects.toThrow(
      /General Reserve cannot be used as a Project Clone source/,
    )
  })

  it('rejects a project that is both General Reserve and a clone', async () => {
    const ordinary = await migrated.db.query<{ id: string }>(
      `insert into projects (name, type, start_date, end_date, status, client_timestamp)
       values ('Template Festival', 'FESTIVAL', now(), now(), 'PLANNING', now())
       returning id`,
    )
    const ordinaryId = ordinary.rows[0]?.id

    await expect(
      migrated.db.query(
        `insert into projects (name, type, start_date, end_date, status, is_general_reserve, cloned_from_project_id, client_timestamp)
         values ('Fake Reserve', 'GENERAL_RESERVE', now(), now(), 'ACTIVE', true, $1, now())`,
        [ordinaryId],
      ),
    ).rejects.toThrow()
  })

  it('rejects closing the General Reserve', async () => {
    const gr = await migrated.db.query<{ id: string }>(
      `select id from projects where is_general_reserve = true`,
    )
    const generalReserveId = gr.rows[0]?.id

    await expect(
      migrated.db.query(`update projects set status = 'CLOSED' where id = $1`, [
        generalReserveId,
      ]),
    ).rejects.toThrow()
  })

  it('allows an ordinary project to be created and cloned from another ordinary project', async () => {
    const source = await migrated.db.query<{ id: string }>(
      `insert into projects (name, type, start_date, end_date, status, client_timestamp)
       values ('Ganesh Chaturthi 2025', 'FESTIVAL', now(), now(), 'COMPLETED', now())
       returning id`,
    )
    const sourceId = source.rows[0]?.id

    await expect(
      migrated.db.query(
        `insert into projects (name, type, start_date, end_date, status, cloned_from_project_id, client_timestamp)
         values ('Ganesh Chaturthi 2026', 'FESTIVAL', now(), now(), 'PLANNING', $1, now())`,
        [sourceId],
      ),
    ).resolves.toBeDefined()
  })
})
