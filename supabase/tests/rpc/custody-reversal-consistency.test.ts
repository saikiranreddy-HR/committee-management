import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'
import {
  commitmentOutstanding,
  createCategory,
  createCommitment,
  createUser,
  createProject,
  custodyBalance,
  getGeneralReserveId,
  netPerformance,
  postTransaction,
  projectLiquidity,
  recognizedExpense,
  recognizedIncome,
  rupees,
  seedGeneralReserve,
  uniqueKey,
} from './helpers.js'

/**
 * Phase 2B surgical correction: custody/reversal consistency.
 *
 * BUG (fixed in migration 00000000000016_financial_effect_engine.sql):
 * a REVERSAL of an INTERNAL_CASH_DISBURSEMENT inherits
 * `custody_advance_transaction_id` from the original disbursement
 * (§10.2), which is always NULL for a disbursement (it CREATES a
 * custody advance, it does not reference one). `financial_custody_balance()`
 * previously only looked at (a) the disbursement's own row and
 * (b) transactions whose `custody_advance_transaction_id` points at
 * the disbursement -- neither matched the disbursement's own
 * reversal, so its -A custody effect was silently dropped from the
 * aggregate while its +A/-A liquidity effect was correctly counted.
 * Net result: project liquidity would be restored on reversal, but
 * custody balance would stay stuck at A. Fixed by adding a third
 * clause that also sums the cash_custody effect of any POSTED
 * transaction whose `reverses_transaction_id` is the disbursement
 * itself.
 */
describe('Phase 2B correction: custody/reversal consistency', () => {
  let migrated: MigratedDatabase
  let userId: string
  let generalReserveId: string
  let projectId: string
  let expenseCategoryId: string

  beforeEach(async () => {
    migrated = await createMigratedDatabase()
    userId = await createUser(migrated.db, 'ravi')
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

  // ------------------------------------------------------------
  // 1 & 2 & 3. Disbursement of ₹10,000, then full reversal: custody
  //            and liquidity both return exactly to their
  //            pre-disbursement values, no phantom custody remains.
  // ------------------------------------------------------------
  it('1-3. reversing an INTERNAL_CASH_DISBURSEMENT of ₹10,000 fully restores custody to ₹0 and liquidity to its pre-disbursement value', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(50000),
    })
    const liquidityBeforeDisbursement = await projectLiquidity(
      migrated.db,
      projectId,
    )

    const disbursement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('disburse'),
      transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(10000),
      cash_handler_user_id: userId,
    })

    // After disbursement.
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(10000),
    )
    expect(await projectLiquidity(migrated.db, projectId)).toBe(
      liquidityBeforeDisbursement - rupees(10000),
    )

    const reversal = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse-disbursement'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: disbursement.id,
    })

    expect(reversal.status).toBe('POSTED')

    // After reversal: custody is exactly ₹0 (no phantom custody),
    // liquidity is exactly restored to its pre-disbursement value.
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(0)
    expect(await projectLiquidity(migrated.db, projectId)).toBe(
      liquidityBeforeDisbursement,
    )

    // Full assertion set requested: liquidity, custody, recognized
    // income, recognized expense, commitment outstanding.
    expect(await recognizedIncome(migrated.db, projectId)).toBe(0)
    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)
  })

  // ------------------------------------------------------------
  // 4. Reversing a custody-linked EXPENSE_DIRECT restores the
  //    custody it consumed (this path was already correct before the
  //    fix -- included here as a regression guard proving the fix
  //    did not disturb it).
  // ------------------------------------------------------------
  it('4. reversing a custody-linked EXPENSE_DIRECT restores the custody it consumed', async () => {
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
    const spend = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('spend'),
      transaction_type: 'EXPENSE_DIRECT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(25000),
      custody_advance_transaction_id: disbursement.id,
      cash_handler_user_id: userId,
    })

    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(5000),
    )
    expect(await recognizedExpense(migrated.db, projectId)).toBe(rupees(25000))

    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse-spend'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: spend.id,
    })

    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(30000),
    )
    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)
    expect(await projectLiquidity(migrated.db, projectId)).toBe(0) // disbursement not reversed
  })

  // ------------------------------------------------------------
  // 5. Reversing a custody-linked EXPENSE_SETTLEMENT restores
  //    custody, recognized expense, and commitment outstanding.
  // ------------------------------------------------------------
  it('5. reversing a custody-linked EXPENSE_SETTLEMENT restores custody, expense, and commitment outstanding', async () => {
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
    const commitmentId = await createCommitment(
      migrated.db,
      projectId,
      expenseCategoryId,
      'OUTFLOW',
      rupees(30000),
      'Flower Vendor',
    )
    const settlement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('custody-settlement'),
      transaction_type: 'EXPENSE_SETTLEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(25000),
      recognized_amount_minor_units: rupees(25000),
      commitment_id: commitmentId,
      custody_advance_transaction_id: disbursement.id,
      cash_handler_user_id: userId,
    })

    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(5000),
    )
    expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
      rupees(5000),
    )

    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse-settlement'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: settlement.id,
    })

    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(30000),
    )
    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)
    expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
      rupees(30000),
    )
  })

  // ------------------------------------------------------------
  // 6. Reversing INTERNAL_CASH_RETURN restores the previous
  //    custody/liquidity state.
  // ------------------------------------------------------------
  it('6. reversing an INTERNAL_CASH_RETURN restores the previous custody/liquidity state', async () => {
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
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('spend'),
      transaction_type: 'EXPENSE_DIRECT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(25000),
      custody_advance_transaction_id: disbursement.id,
      cash_handler_user_id: userId,
    })
    const ret = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('return'),
      transaction_type: 'INTERNAL_CASH_RETURN',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(5000),
      custody_advance_transaction_id: disbursement.id,
      cash_handler_user_id: userId,
    })

    // Before reversing the return.
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(0)
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(5000))

    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse-return'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: ret.id,
    })

    // After reversing the return: the ₹5,000 is back in custody, and
    // out of project liquidity again.
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(5000),
    )
    expect(await projectLiquidity(migrated.db, projectId)).toBe(0)
  })

  // ------------------------------------------------------------
  // 7. Reversal never creates or destroys money beyond the exact
  //    inverse of the seven-effect vector.
  // ------------------------------------------------------------
  it('7. reversal creates or destroys no money beyond the exact inverse seven-effect vector', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(20000),
    })
    const disbursement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('disburse'),
      transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(20000),
      cash_handler_user_id: userId,
    })

    const reserveBefore = await projectLiquidity(migrated.db, generalReserveId)
    const projectBefore = await projectLiquidity(migrated.db, projectId)
    const custodyBefore = await custodyBalance(migrated.db, disbursement.id)

    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: disbursement.id,
    })

    const reserveAfter = await projectLiquidity(migrated.db, generalReserveId)
    const projectAfter = await projectLiquidity(migrated.db, projectId)
    const custodyAfter = await custodyBalance(migrated.db, disbursement.id)

    // Total system money (project liquidity + General Reserve
    // liquidity + custody) is exactly conserved -- the reversal only
    // moved value between these three buckets, it created none.
    const totalBefore = reserveBefore + projectBefore + custodyBefore
    const totalAfter = reserveAfter + projectAfter + custodyAfter
    expect(totalAfter).toBe(totalBefore)

    // And specifically: liquidity increased by exactly A, custody
    // decreased by exactly A (the mathematical inverse of the
    // original disbursement's vector).
    expect(projectAfter - projectBefore).toBe(rupees(20000))
    expect(custodyAfter - custodyBefore).toBe(-rupees(20000))
  })

  // ------------------------------------------------------------
  // 8. Full sequence: disbursement -> custody-linked spend -> partial
  //    return -> valid reversal where permitted. Derived custody
  //    state matches exactly what the underlying POSTED effects
  //    imply at every step.
  // ------------------------------------------------------------
  it('8. full disbursement -> spend -> partial return -> reversal sequence preserves exact derived custody state', async () => {
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
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(30000),
    )

    const spend = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('spend'),
      transaction_type: 'EXPENSE_DIRECT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(20000),
      custody_advance_transaction_id: disbursement.id,
      cash_handler_user_id: userId,
    })
    // custody: 30000 - 20000 = 10000
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(10000),
    )

    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('partial-return'),
      transaction_type: 'INTERNAL_CASH_RETURN',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(4000),
      custody_advance_transaction_id: disbursement.id,
      cash_handler_user_id: userId,
    })
    // custody: 10000 - 4000 = 6000
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(6000),
    )
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(4000))

    // Reverse the spend (permitted: no reversal of it exists yet).
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse-spend-in-sequence'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: spend.id,
    })
    // custody: 6000 + 20000 (spend reversed) = 26000
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
      rupees(26000),
    )
    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)

    // Now reverse the disbursement itself is NOT permitted while
    // custody remains outstanding in the domain sense, but Phase 2B's
    // RPC does not yet implement that specific business rule (it is
    // not one of the 65 invariants' literal text and is out of this
    // correction's scope) -- what IS verified here is that the
    // reversal mechanism itself remains mathematically exact even in
    // a multi-step sequence, matching a raw sum over financial_effects.
    const drilldown = await migrated.db.query<{ total: string }>(
      `select
         coalesce((select cash_custody from financial_effects where transaction_id = $1 and status = 'POSTED'), 0)
         + coalesce((select sum(cash_custody) from financial_effects where custody_advance_transaction_id = $1 and status = 'POSTED'), 0)
         + coalesce((select sum(cash_custody) from financial_effects where reverses_transaction_id = $1 and status = 'POSTED'), 0)
         as total`,
      [disbursement.id],
    )
    expect(Number(drilldown.rows[0]?.total)).toBe(
      await custodyBalance(migrated.db, disbursement.id),
    )
  })

  // ------------------------------------------------------------
  // 9. Reversal uniqueness remains enforced (regression guard).
  // ------------------------------------------------------------
  it('9. a second reversal of the same disbursement is rejected (Invariant 59)', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(10000),
    })
    const disbursement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('disburse'),
      transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(10000),
      cash_handler_user_id: userId,
    })

    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse-once'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: disbursement.id,
    })

    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('reverse-twice'),
        transaction_type: 'REVERSAL',
        created_by_user_id: userId,
        reverses_transaction_id: disbursement.id,
      }),
    ).rejects.toThrow(/already has an active POSTED reversal/)

    // Custody remains correctly at 0 -- not double-reversed to -A.
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(0)
  })

  // ------------------------------------------------------------
  // 10. Concurrent reversal attempts against the same original still
  //     allow at most one POSTED reversal (disclosed scope: PGlite
  //     serializes queries internally -- see
  //     concurrency-and-authorization.test.ts's file-header
  //     disclosure for the same honest limitation repeated here).
  // ------------------------------------------------------------
  it('10. "concurrent" reversal attempts against the same disbursement still produce at most one POSTED reversal', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(15000),
    })
    const disbursement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('disburse'),
      transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(15000),
      cash_handler_user_id: userId,
    })

    const results = await Promise.allSettled([
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('reverse-a'),
        transaction_type: 'REVERSAL',
        created_by_user_id: userId,
        reverses_transaction_id: disbursement.id,
      }),
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('reverse-b'),
        transaction_type: 'REVERSAL',
        created_by_user_id: userId,
        reverses_transaction_id: disbursement.id,
      }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1)

    const count = await migrated.db.query<{ count: string }>(
      `select count(*)::text as count from transactions
        where reverses_transaction_id = $1 and status = 'POSTED'`,
      [disbursement.id],
    )
    expect(count.rows[0]?.count).toBe('1')
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(0)
  })

  it('regression: net performance is unaffected by a pure custody disbursement/reversal cycle (no income or expense created)', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(10000),
    })
    const disbursement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('disburse'),
      transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(10000),
      cash_handler_user_id: userId,
    })
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: disbursement.id,
    })

    expect(await netPerformance(migrated.db, projectId)).toBe(0)
  })
})
