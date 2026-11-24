import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'
import {
  commitmentOutstanding,
  createCategory,
  createCommitment,
  createProject,
  createUser,
  custodyBalance,
  getGeneralReserveId,
  postTransaction,
  projectLiquidity,
  rupees,
  seedGeneralReserve,
  uniqueKey,
} from './helpers.js'

/**
 * Phase 2B: concurrency safety, maker-checker, General Reserve
 * participation restriction, and closed-project rejection.
 *
 * ============================================================
 * DISCLOSED BLOCKER -- read before trusting the "concurrency" tests:
 * ============================================================
 * PGlite (the embedded PostgreSQL used throughout this test suite)
 * runs as a single WASM process and internally serializes ALL query
 * execution through one exclusive transaction queue -- it does not
 * provide multiple genuinely concurrent connections. This means a
 * true multi-connection race condition (two separate database
 * sessions racing on the same `SELECT ... FOR UPDATE` row lock) CANNOT
 * be exercised in this sandbox, and this suite does not claim to have
 * done so. A real Supabase/PostgreSQL environment (with the
 * `pg`/`postgres` driver opening multiple real connections) is
 * required to observe genuine lock-contention/blocking behavior end
 * to end; that environment was unavailable here (no Docker/psql/
 * Supabase CLI -- see prior Phase 2A reports for the same disclosed
 * limitation).
 *
 * What IS genuinely verified below, without simulating anything:
 *   1. The RPC's SQL text actually contains `for update` locking on
 *      the commitment/custody-disbursement/project rows (a structural
 *      fact about the deployed function, checked via pg_get_functiondef
 *      -- not merely asserted in a comment).
 *   2. The boundary-check LOGIC itself is correct: a sequence of
 *      postings that together would exceed a commitment/custody/
 *      liquidity bound is rejected at the exact boundary, and an
 *      idempotent duplicate (fired twice) never double-applies its
 *      effect. This proves the safety mechanism is correct in
 *      isolation; it does not prove timing-based race safety under
 *      true concurrent connections, which remains unverified pending
 *      a real Postgres environment.
 * ============================================================
 */
describe('Phase 2B concurrency mechanism, maker-checker, and remaining coverage', () => {
  let migrated: MigratedDatabase
  let userId: string
  let approverId: string
  let generalReserveId: string
  let projectId: string
  let expenseCategoryId: string

  beforeEach(async () => {
    migrated = await createMigratedDatabase()
    userId = await createUser(migrated.db, 'ravi')
    approverId = await createUser(migrated.db, 'suresh')
    generalReserveId = await getGeneralReserveId(migrated.db)
    projectId = await createProject(migrated.db, 'Ganesh Chaturthi 2026')
    expenseCategoryId = await createCategory(
      migrated.db,
      projectId,
      'Decoration',
    )
    await seedGeneralReserve(
      migrated.db,
      generalReserveId,
      rupees(1000000),
      userId,
    )
  })

  afterEach(async () => {
    await migrated.db.close()
  })

  describe('20. Concurrency mechanism (disclosed scope -- see file header)', () => {
    it('the deployed RPC actually uses SELECT ... FOR UPDATE locking on commitments, custody disbursements, and projects', async () => {
      const result = await migrated.db.query<{ definition: string }>(
        `select pg_get_functiondef('financial_post_transaction'::regproc) as definition`,
      )
      const source = result.rows[0]?.definition ?? ''

      expect(source).toMatch(
        /from commitments where id = v_commitment_id for update/,
      )
      expect(source).toMatch(
        /from transactions where id = v_custody_id for update/,
      )
      expect(source).toMatch(/from projects where id = v_lock_id for update/)
      expect(source).toMatch(
        /from transactions where id = p_reverses_transaction_id for update/,
      )
    })

    it('commitment boundary logic is exact under a rapid sequence of postings (sequential proxy for concurrent contention)', async () => {
      const commitmentId = await createCommitment(
        migrated.db,
        projectId,
        expenseCategoryId,
        'OUTFLOW',
        rupees(100000),
      )
      await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('fund'),
        transaction_type: 'INTERNAL_FUND_TRANSFER',
        created_by_user_id: userId,
        source_project_id: generalReserveId,
        destination_project_id: projectId,
        amount_minor_units: rupees(200000),
      })

      // Two "simultaneous" settlement attempts of ₹60,000 each against
      // a ₹1,00,000 commitment: only the first can succeed once the
      // second would push settled-total over 100000.
      const results = await Promise.allSettled([
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('settle-a'),
          transaction_type: 'EXPENSE_ADVANCE',
          created_by_user_id: userId,
          source_project_id: projectId,
          amount_minor_units: rupees(60000),
          commitment_id: commitmentId,
        }),
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('settle-b'),
          transaction_type: 'EXPENSE_ADVANCE',
          created_by_user_id: userId,
          source_project_id: projectId,
          amount_minor_units: rupees(60000),
          commitment_id: commitmentId,
        }),
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
        rupees(40000),
      )
    })

    it('custody boundary logic is exact under a rapid sequence of postings', async () => {
      await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('fund'),
        transaction_type: 'INTERNAL_FUND_TRANSFER',
        created_by_user_id: userId,
        source_project_id: generalReserveId,
        destination_project_id: projectId,
        amount_minor_units: rupees(30000),
      })
      const disbursement = await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('disburse'),
        transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(30000),
        cash_handler_user_id: userId,
      })

      const results = await Promise.allSettled([
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('spend-a'),
          transaction_type: 'EXPENSE_DIRECT',
          created_by_user_id: userId,
          source_project_id: projectId,
          amount_minor_units: rupees(20000),
          custody_advance_transaction_id: disbursement.id,
          cash_handler_user_id: userId,
        }),
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('spend-b'),
          transaction_type: 'EXPENSE_DIRECT',
          created_by_user_id: userId,
          source_project_id: projectId,
          amount_minor_units: rupees(20000),
          custody_advance_transaction_id: disbursement.id,
          cash_handler_user_id: userId,
        }),
      ])

      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
      expect(results.filter((r) => r.status === 'rejected').length).toBe(1)
      expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
        rupees(10000),
      )
    })

    it('duplicate idempotency requests fired together never double-apply their effect', async () => {
      const donor = await createUser(migrated.db, 'donor3')
      const key = uniqueKey('race-duplicate')

      const results = await Promise.allSettled([
        postTransaction(migrated.db, {
          idempotency_key: key,
          transaction_type: 'DONATION_MEMBER',
          created_by_user_id: userId,
          destination_project_id: projectId,
          amount_minor_units: rupees(1000),
          donor_user_id: donor,
        }),
        postTransaction(migrated.db, {
          idempotency_key: key,
          transaction_type: 'DONATION_MEMBER',
          created_by_user_id: userId,
          destination_project_id: projectId,
          amount_minor_units: rupees(1000),
          donor_user_id: donor,
        }),
      ])

      // Both calls resolve (idempotent replay returns the same row
      // rather than erroring), but exactly one transaction exists.
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(1000))

      const count = await migrated.db.query<{ count: string }>(
        `select count(*)::text as count from transactions where idempotency_key = $1`,
        [key],
      )
      expect(count.rows[0]?.count).toBe('1')
    })
  })

  describe('Maker-checker via the RPC', () => {
    it('rejects a transaction approved by its own creator', async () => {
      const donor = await createUser(migrated.db, 'donor4')
      await expect(
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('self-approve'),
          transaction_type: 'DONATION_MEMBER',
          created_by_user_id: userId,
          destination_project_id: projectId,
          amount_minor_units: rupees(1000),
          donor_user_id: donor,
          approved_by_user_id: userId,
        }),
      ).rejects.toThrow()
    })

    it('accepts a transaction approved by a different user, tagged atomically at post time', async () => {
      const donor = await createUser(migrated.db, 'donor5')
      const tx = await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('valid-approve'),
        transaction_type: 'DONATION_MEMBER',
        created_by_user_id: userId,
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
        donor_user_id: donor,
        approved_by_user_id: approverId,
      })
      expect(tx.approved_by_user_id).toBe(approverId)
    })
  })

  describe('General Reserve participation restriction', () => {
    it('rejects a DONATION_PUBLIC directly into General Reserve', async () => {
      await expect(
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('bad-gr-donation'),
          transaction_type: 'DONATION_PUBLIC',
          created_by_user_id: userId,
          destination_project_id: generalReserveId,
          amount_minor_units: rupees(1000),
        }),
      ).rejects.toThrow(/General Reserve may only participate/)
    })

    it('rejects an EXPENSE_DIRECT sourced from General Reserve', async () => {
      await expect(
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('bad-gr-expense'),
          transaction_type: 'EXPENSE_DIRECT',
          created_by_user_id: userId,
          source_project_id: generalReserveId,
          amount_minor_units: rupees(1000),
        }),
      ).rejects.toThrow(/General Reserve may only participate/)
    })

    it('allows INTERNAL_FUND_TRANSFER to and from General Reserve', async () => {
      await expect(
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('good-gr-transfer'),
          transaction_type: 'INTERNAL_FUND_TRANSFER',
          created_by_user_id: userId,
          source_project_id: generalReserveId,
          destination_project_id: projectId,
          amount_minor_units: rupees(1000),
        }),
      ).resolves.toBeDefined()
    })
  })

  describe('Closed-project mutation rejection (Invariant 39)', () => {
    it('rejects a new EXPENSE_DIRECT against a CLOSED project', async () => {
      const closedProjectId = await createProject(
        migrated.db,
        'Old Festival',
        'CLOSED',
      )
      await expect(
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('closed-expense'),
          transaction_type: 'EXPENSE_DIRECT',
          created_by_user_id: userId,
          source_project_id: closedProjectId,
          amount_minor_units: rupees(1000),
        }),
      ).rejects.toThrow(/CLOSED/)
    })

    it('still allows a REVERSAL against a transaction whose project has since been closed (§17.9)', async () => {
      await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('fund'),
        transaction_type: 'INTERNAL_FUND_TRANSFER',
        created_by_user_id: userId,
        source_project_id: generalReserveId,
        destination_project_id: projectId,
        amount_minor_units: rupees(5000),
      })
      const expense = await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('expense'),
        transaction_type: 'EXPENSE_DIRECT',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(2000),
      })

      // Project closure execution itself is out of scope for Phase
      // 2B; this directly sets status to simulate the post-condition
      // of a (not-yet-implemented) closure RPC, solely to test that
      // reversal remains available afterward per §17.9.
      await migrated.db.query(
        `update projects set status = 'CLOSED' where id = $1`,
        [projectId],
      )

      await expect(
        postTransaction(migrated.db, {
          idempotency_key: uniqueKey('reverse-after-close'),
          transaction_type: 'REVERSAL',
          created_by_user_id: userId,
          reverses_transaction_id: expense.id,
        }),
      ).resolves.toBeDefined()
    })

    it('Invariant 38: a closed project remains historically queryable', async () => {
      await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('fund'),
        transaction_type: 'INTERNAL_FUND_TRANSFER',
        created_by_user_id: userId,
        source_project_id: generalReserveId,
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
      })
      await migrated.db.query(
        `update projects set status = 'CLOSED' where id = $1`,
        [projectId],
      )

      const result = await migrated.db.query<{ id: string; status: string }>(
        `select id, status from projects where id = $1`,
        [projectId],
      )
      expect(result.rows[0]?.status).toBe('CLOSED')
      // Derived financial state remains fully computable/queryable
      // for a closed project -- closure never hides history.
      expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(1000))
    })
  })

  describe('Invariant 64: Universal Status Safety', () => {
    it('a non-POSTED transaction contributes zero to derived financial state', async () => {
      const donor = await createUser(migrated.db, 'donor-status-safety')

      // financial_post_transaction always posts as POSTED (Phase 2B
      // scope note); to exercise status safety we insert a non-POSTED
      // row directly, bypassing the RPC, purely as test setup -- this
      // is legitimate test scaffolding, not a claim that the
      // application ever does this.
      await migrated.db.query(
        `insert into transactions (
           destination_project_id, transaction_type, description,
           amount_minor_units, payment_source, donor_user_id,
           transaction_date, status, created_by_user_id, created_at,
           idempotency_key, client_timestamp
         ) values (
           $1, 'DONATION_MEMBER', 'Draft donation',
           $2, 'CASH', $3,
           now(), 'DRAFT', $3, now(),
           $4, now()
         )`,
        [projectId, rupees(9999), donor, uniqueKey('draft-donation')],
      )

      expect(await projectLiquidity(migrated.db, projectId)).toBe(0)
    })
  })
})
