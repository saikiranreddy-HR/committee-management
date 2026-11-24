import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'

/**
 * Phase 2A correction -- Issue 3: structural rejection behavior tests.
 *
 * These tests exercise actual database behavior (real INSERT/UPDATE
 * statements against a real, embedded PostgreSQL instance via
 * PGlite) -- they do not merely inspect whether a constraint exists
 * in pg_catalog. Each test constructs a row that is valid in every
 * respect except the single rule under test, and asserts the database
 * itself rejects it.
 *
 * No financial engine, RPC, or application-level validation is
 * exercised or implemented here -- only the raw structural
 * constraints already present in the Phase 2A schema.
 */
describe('Phase 2A structural rejection behavior', () => {
  let migrated: MigratedDatabase
  let userAId: string
  let userBId: string
  let projectId: string
  let categoryId: string
  let idempotencyCounter = 0

  function nextIdempotencyKey(): string {
    idempotencyCounter += 1
    return `test-idem-${idempotencyCounter}`
  }

  beforeEach(async () => {
    migrated = await createMigratedDatabase()

    const userA = await migrated.db.query<{ id: string }>(
      `insert into users (id, username, display_name, created_at)
       values (gen_random_uuid(), 'ravi', 'Ravi Kumar', now())
       returning id`,
    )
    userAId = userA.rows[0]!.id

    const userB = await migrated.db.query<{ id: string }>(
      `insert into users (id, username, display_name, created_at)
       values (gen_random_uuid(), 'suresh', 'Suresh Iyer', now())
       returning id`,
    )
    userBId = userB.rows[0]!.id

    const project = await migrated.db.query<{ id: string }>(
      `insert into projects (name, type, start_date, end_date, status, client_timestamp)
       values ('Ganesh Chaturthi', 'FESTIVAL', now(), now(), 'ACTIVE', now())
       returning id`,
    )
    projectId = project.rows[0]!.id

    const category = await migrated.db.query<{ id: string }>(
      `insert into project_categories (project_id, name, category_type)
       values ($1, 'Decoration', 'EXPENSE')
       returning id`,
      [projectId],
    )
    categoryId = category.rows[0]!.id
  })

  afterEach(async () => {
    await migrated.db.close()
  })

  /** Minimal, otherwise-valid base fields for a DONATION_MEMBER row. */
  function baseDonationMember(overrides: Record<string, unknown> = {}) {
    return {
      destination_project_id: projectId,
      transaction_type: 'DONATION_MEMBER',
      description: "Ravi's donation",
      amount_minor_units: 500000,
      payment_source: 'CASH',
      donor_user_id: userAId,
      transaction_date: new Date().toISOString(),
      status: 'DRAFT',
      created_by_user_id: userAId,
      created_at: new Date().toISOString(),
      idempotency_key: nextIdempotencyKey(),
      client_timestamp: new Date().toISOString(),
      ...overrides,
    }
  }

  async function insertTransaction(fields: Record<string, unknown>) {
    const columns = Object.keys(fields)
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
    const values = columns.map((c) => fields[c])
    return migrated.db.query<{ id: string }>(
      `insert into transactions (${columns.join(', ')})
       values (${placeholders})
       returning id`,
      values,
    )
  }

  describe('1. Invalid donation routing', () => {
    it('rejects DONATION_MEMBER with no donor_user_id', async () => {
      const fields = baseDonationMember({ donor_user_id: null })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('rejects DONATION_PUBLIC with a donor_user_id set', async () => {
      const fields = baseDonationMember({
        transaction_type: 'DONATION_PUBLIC',
        donor_user_id: userAId, // DONATION_PUBLIC must NOT have a donor
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('rejects a DONATION_% transaction with source_project_id also set', async () => {
      const fields = baseDonationMember({ source_project_id: projectId })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('accepts a correctly-shaped DONATION_MEMBER (control case)', async () => {
      await expect(
        insertTransaction(baseDonationMember()),
      ).resolves.toBeDefined()
    })
  })

  describe('2. Invalid expense routing', () => {
    it('rejects EXPENSE_DIRECT with destination_project_id also set', async () => {
      const fields = baseDonationMember({
        transaction_type: 'EXPENSE_DIRECT',
        source_project_id: projectId,
        destination_project_id: projectId, // both set -> invalid for EXPENSE_%
        donor_user_id: null,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('rejects EXPENSE_ADVANCE without a commitment_id', async () => {
      const fields = baseDonationMember({
        transaction_type: 'EXPENSE_ADVANCE',
        destination_project_id: null,
        source_project_id: projectId,
        donor_user_id: null,
        commitment_id: null,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('accepts a correctly-shaped EXPENSE_DIRECT (control case)', async () => {
      const fields = baseDonationMember({
        transaction_type: 'EXPENSE_DIRECT',
        destination_project_id: null,
        source_project_id: projectId,
        donor_user_id: null,
      })
      await expect(insertTransaction(fields)).resolves.toBeDefined()
    })
  })

  describe('3. Self-approval (maker-checker)', () => {
    it('rejects a transaction approved by its own creator', async () => {
      const fields = baseDonationMember({ approved_by_user_id: userAId })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('accepts a transaction approved by a different user (control case)', async () => {
      const fields = baseDonationMember({ approved_by_user_id: userBId })
      await expect(insertTransaction(fields)).resolves.toBeDefined()
    })

    it('rejects a deficit review approved by its own reviewer', async () => {
      await expect(
        migrated.db.query(
          `insert into project_deficit_reviews (
             project_id, deficit_amount_minor_units, reason, explanation,
             reviewed_by_user_id, reviewed_at, approved_by_user_id, status
           ) values ($1, 1000000, 'Overspend', 'Vendor costs exceeded budget', $2, now(), $2, 'APPROVED')`,
          [projectId, userAId],
        ),
      ).rejects.toThrow()
    })
  })

  describe('4. REVERSAL without an original transaction', () => {
    it('rejects a REVERSAL with no reverses_transaction_id', async () => {
      const fields = baseDonationMember({
        transaction_type: 'REVERSAL',
        reverses_transaction_id: null,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })
  })

  describe('5. Non-REVERSAL with a reversal reference', () => {
    it('rejects a DONATION_MEMBER that sets reverses_transaction_id', async () => {
      const original = await insertTransaction(baseDonationMember())
      const originalId = original.rows[0]!.id

      const fields = baseDonationMember({
        reverses_transaction_id: originalId,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })
  })

  describe('6. Invalid custody linkage', () => {
    it('rejects custody_advance_transaction_id on a type not in the custody whitelist', async () => {
      const existing = await insertTransaction(baseDonationMember())
      const existingId = existing.rows[0]!.id

      // DONATION_MEMBER is not one of EXPENSE_DIRECT / EXPENSE_ADVANCE /
      // EXPENSE_SETTLEMENT / INTERNAL_CASH_RETURN.
      const fields = baseDonationMember({
        custody_advance_transaction_id: existingId,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })
  })

  describe('7. INTERNAL_CASH_RETURN without a custody advance reference', () => {
    it('rejects INTERNAL_CASH_RETURN with custody_advance_transaction_id = NULL', async () => {
      const fields = baseDonationMember({
        transaction_type: 'INTERNAL_CASH_RETURN',
        destination_project_id: projectId,
        donor_user_id: null,
        cash_handler_user_id: userAId,
        custody_advance_transaction_id: null,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('accepts INTERNAL_CASH_RETURN with a valid custody advance reference (control case)', async () => {
      const disbursement = await insertTransaction(
        baseDonationMember({
          transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
          destination_project_id: null,
          source_project_id: projectId,
          donor_user_id: null,
          cash_handler_user_id: userAId,
        }),
      )
      const disbursementId = disbursement.rows[0]!.id

      const fields = baseDonationMember({
        transaction_type: 'INTERNAL_CASH_RETURN',
        destination_project_id: projectId,
        donor_user_id: null,
        cash_handler_user_id: userAId,
        custody_advance_transaction_id: disbursementId,
      })
      await expect(insertTransaction(fields)).resolves.toBeDefined()
    })
  })

  describe('8. VOIDED transaction without a void reason', () => {
    it('rejects status=VOIDED with void_reason = NULL', async () => {
      const fields = baseDonationMember({
        status: 'VOIDED',
        void_reason: null,
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('accepts status=VOIDED with a void_reason set (control case)', async () => {
      const fields = baseDonationMember({
        status: 'VOIDED',
        void_reason: 'Entered in error',
      })
      await expect(insertTransaction(fields)).resolves.toBeDefined()
    })
  })

  describe('15. Required foreign-key behavior', () => {
    it('rejects a transaction referencing a non-existent created_by_user_id', async () => {
      const fields = baseDonationMember({
        created_by_user_id: '00000000-0000-0000-0000-000000000000',
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('rejects a transaction referencing a non-existent destination_project_id', async () => {
      const fields = baseDonationMember({
        destination_project_id: '00000000-0000-0000-0000-000000000000',
      })
      await expect(insertTransaction(fields)).rejects.toThrow()
    })

    it('rejects a commitment referencing a non-existent project_id', async () => {
      await expect(
        migrated.db.query(
          `insert into commitments (project_id, category_id, direction, party_name, committed_amount_minor_units)
           values ('00000000-0000-0000-0000-000000000000', $1, 'OUTFLOW', 'ABC Decorators', 10000000)`,
          [categoryId],
        ),
      ).rejects.toThrow()
    })
  })
})
