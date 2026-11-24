import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'

/**
 * Source: architecturefinal-v4.5.1.md §6.1 ("Physical deletion of
 * projects, transactions, commitments, audit events, or users is
 * strictly prohibited"); §13 Invariant 40; §6 entity 14 comment
 * ("Audit Events ... STRICTLY APPEND ONLY").
 */
describe('Phase 2A immutability / physical-delete ban', () => {
  let migrated: MigratedDatabase
  let userId: string
  let projectId: string

  beforeEach(async () => {
    migrated = await createMigratedDatabase()

    const user = await migrated.db.query<{ id: string }>(
      `insert into users (id, username, display_name, created_at)
       values (gen_random_uuid(), 'ravi', 'Ravi Kumar', now())
       returning id`,
    )
    userId = user.rows[0]!.id

    const project = await migrated.db.query<{ id: string }>(
      `insert into projects (name, type, start_date, end_date, status, client_timestamp)
       values ('Ganesh Chaturthi', 'FESTIVAL', now(), now(), 'ACTIVE', now())
       returning id`,
    )
    projectId = project.rows[0]!.id
  })

  afterEach(async () => {
    await migrated.db.close()
  })

  it('rejects physical deletion of a project', async () => {
    await expect(
      migrated.db.query(`delete from projects where id = $1`, [projectId]),
    ).rejects.toThrow(/Physical deletion of projects is not permitted/)
  })

  it('rejects physical deletion of a user', async () => {
    await expect(
      migrated.db.query(`delete from users where id = $1`, [userId]),
    ).rejects.toThrow(/Physical deletion of users is not permitted/)
  })

  it('rejects physical deletion of a commitment', async () => {
    const category = await migrated.db.query<{ id: string }>(
      `insert into project_categories (project_id, name, category_type)
       values ($1, 'Decoration', 'EXPENSE')
       returning id`,
      [projectId],
    )
    const categoryId = category.rows[0]!.id

    const commitment = await migrated.db.query<{ id: string }>(
      `insert into commitments (project_id, category_id, direction, party_name, committed_amount_minor_units)
       values ($1, $2, 'OUTFLOW', 'ABC Decorators', 10000000)
       returning id`,
      [projectId, categoryId],
    )
    const commitmentId = commitment.rows[0]!.id

    await expect(
      migrated.db.query(`delete from commitments where id = $1`, [
        commitmentId,
      ]),
    ).rejects.toThrow(/Physical deletion of commitments is not permitted/)
  })

  it('rejects physical deletion of a transaction', async () => {
    const transaction = await migrated.db.query<{ id: string }>(
      `insert into transactions (
         destination_project_id, transaction_type, description,
         amount_minor_units, payment_source, donor_user_id,
         transaction_date, status, created_by_user_id, created_at,
         idempotency_key, client_timestamp
       ) values (
         $1, 'DONATION_MEMBER', 'Ravi''s donation',
         500000, 'CASH', $2,
         now(), 'DRAFT', $2, now(),
         'test-idem-key-001', now()
       )
       returning id`,
      [projectId, userId],
    )
    const transactionId = transaction.rows[0]!.id

    await expect(
      migrated.db.query(`delete from transactions where id = $1`, [
        transactionId,
      ]),
    ).rejects.toThrow(/Physical deletion of transactions is not permitted/)
  })

  it('rejects physical deletion of an audit event', async () => {
    const auditEvent = await migrated.db.query<{ id: string }>(
      `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp)
       values ('projects', $1, 'CREATE', $2, 1, '{"status": "ACTIVE"}'::jsonb, now())
       returning id`,
      [projectId, userId],
    )
    const auditEventId = auditEvent.rows[0]!.id

    await expect(
      migrated.db.query(`delete from audit_events where id = $1`, [
        auditEventId,
      ]),
    ).rejects.toThrow(/Physical deletion of audit_events is not permitted/)
  })

  it('rejects updating an audit event (strictly append-only)', async () => {
    const auditEvent = await migrated.db.query<{ id: string }>(
      `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp)
       values ('projects', $1, 'CREATE', $2, 1, '{"status": "ACTIVE"}'::jsonb, now())
       returning id`,
      [projectId, userId],
    )
    const auditEventId = auditEvent.rows[0]!.id

    await expect(
      migrated.db.query(
        `update audit_events set reason = 'attempted correction' where id = $1`,
        [auditEventId],
      ),
    ).rejects.toThrow(/audit_events is strictly append-only/)
  })

  it('still allows logical deletion via the is_deleted flag', async () => {
    // Physical DELETE is blocked, but the soft-delete column itself
    // must remain an ordinary, updatable column -- this is the
    // designed escape hatch, not an oversight.
    await expect(
      migrated.db.query(`update projects set is_deleted = true where id = $1`, [
        projectId,
      ]),
    ).resolves.toBeDefined()

    const result = await migrated.db.query<{ is_deleted: boolean }>(
      `select is_deleted from projects where id = $1`,
      [projectId],
    )
    expect(result.rows[0]?.is_deleted).toBe(true)
  })
})
