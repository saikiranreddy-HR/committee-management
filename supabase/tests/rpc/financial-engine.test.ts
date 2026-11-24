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
 * Phase 2B financial engine tests. Every expected number below is
 * taken directly from the architecture's own worked examples
 * (architecturefinal-v4.5.1.md §11, Scenarios A-P) -- none are
 * invented. Each test states: input, expected effects, expected state
 * changes, expected rejection where applicable, and post-condition.
 */
describe('Phase 2B financial engine', () => {
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
    // Seed General Reserve generously so tests that transfer FROM it
    // have sufficient funds; seeding goes through the only legitimate
    // path into General Reserve (see seedGeneralReserve).
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

  // --------------------------------------------------------------
  // 1. Donation / recognized income
  // --------------------------------------------------------------
  it('1. DONATION_MEMBER creates recognized income and liquidity in one step', async () => {
    const donor = await createUser(migrated.db, 'donor1')

    const tx = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('donation'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(75000),
      donor_user_id: donor,
    })

    expect(tx.status).toBe('POSTED')
    expect(await recognizedIncome(migrated.db, projectId)).toBe(rupees(75000))
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(75000))
  })

  // --------------------------------------------------------------
  // 2. Auction pledge vs. realized auction income (§7 auction callout)
  // --------------------------------------------------------------
  describe('2. Auction pledge vs. realized income', () => {
    it('an INFLOW commitment (pledge) creates no income and no liquidity', async () => {
      const incomeCategory = await createCategory(
        migrated.db,
        projectId,
        'Auction',
        'INCOME',
      )
      await createCommitment(
        migrated.db,
        projectId,
        incomeCategory,
        'INFLOW',
        rupees(75000),
        'Winning Bidder',
      )

      // Post-condition: a pledge alone (no transaction posted) leaves
      // recognized income and liquidity both at zero.
      expect(await recognizedIncome(migrated.db, projectId)).toBe(0)
      expect(await projectLiquidity(migrated.db, projectId)).toBe(0)
    })

    it('Scenario C: DONATION_AUCTION of ₹75,000 realizes income/liquidity and settles the linked pledge', async () => {
      const incomeCategory = await createCategory(
        migrated.db,
        projectId,
        'Auction',
        'INCOME',
      )
      const pledgeId = await createCommitment(
        migrated.db,
        projectId,
        incomeCategory,
        'INFLOW',
        rupees(75000),
        'Winning Bidder',
      )

      const tx = await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('auction'),
        transaction_type: 'DONATION_AUCTION',
        created_by_user_id: userId,
        destination_project_id: projectId,
        amount_minor_units: rupees(75000),
        commitment_id: pledgeId,
      })

      expect(tx.status).toBe('POSTED')
      expect(await recognizedIncome(migrated.db, projectId)).toBe(rupees(75000))
      expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(75000))
      expect(await commitmentOutstanding(migrated.db, pledgeId)).toBe(0)
    })

    it('a partial auction receipt settles only the amount actually received, not the full pledge', async () => {
      const incomeCategory = await createCategory(
        migrated.db,
        projectId,
        'Auction',
        'INCOME',
      )
      const pledgeId = await createCommitment(
        migrated.db,
        projectId,
        incomeCategory,
        'INFLOW',
        rupees(75000),
        'Winning Bidder',
      )

      await postTransaction(migrated.db, {
        idempotency_key: uniqueKey('auction-partial'),
        transaction_type: 'DONATION_AUCTION',
        created_by_user_id: userId,
        destination_project_id: projectId,
        amount_minor_units: rupees(30000),
        commitment_id: pledgeId,
      })

      expect(await recognizedIncome(migrated.db, projectId)).toBe(rupees(30000))
      expect(await commitmentOutstanding(migrated.db, pledgeId)).toBe(
        rupees(45000),
      )
    })
  })

  // --------------------------------------------------------------
  // 3 & 4. Vendor advance / settlement (Scenarios D & E)
  // --------------------------------------------------------------
  it('3. Scenario D: EXPENSE_ADVANCE of ₹30,000 against a ₹1,00,000 commitment defers recognized expense', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(125000),
    })

    const commitmentId = await createCommitment(
      migrated.db,
      projectId,
      expenseCategoryId,
      'OUTFLOW',
      rupees(100000),
      'ABC Decorators',
    )

    const advance = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('advance'),
      transaction_type: 'EXPENSE_ADVANCE',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(30000),
      commitment_id: commitmentId,
    })

    expect(advance.recognized_amount_minor_units).toBeNull()
    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)
    expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
      rupees(70000),
    )
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(95000))
  })

  it('4. Scenario E: EXPENSE_SETTLEMENT recognizes ₹1,00,000 expense while paying only the remaining ₹70,000 cash', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(125000),
    })
    const commitmentId = await createCommitment(
      migrated.db,
      projectId,
      expenseCategoryId,
      'OUTFLOW',
      rupees(100000),
      'ABC Decorators',
    )
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('advance'),
      transaction_type: 'EXPENSE_ADVANCE',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(30000),
      commitment_id: commitmentId,
    })

    const settlement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('settlement'),
      transaction_type: 'EXPENSE_SETTLEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(70000),
      recognized_amount_minor_units: rupees(100000),
      commitment_id: commitmentId,
    })

    expect(settlement.recognized_amount_minor_units).toBe(rupees(100000))
    expect(await recognizedExpense(migrated.db, projectId)).toBe(rupees(100000))
    expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(0)
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(25000))
  })

  // --------------------------------------------------------------
  // 5. Internal fund transfer (Scenario B) -- transfer is never income
  // --------------------------------------------------------------
  it('5. & 17. Scenario B: INTERNAL_FUND_TRANSFER moves liquidity without creating income', async () => {
    const reserveBalanceBefore = await projectLiquidity(
      migrated.db,
      generalReserveId,
    )

    const tx = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('transfer'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(50000),
    })

    expect(tx.status).toBe('POSTED')
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(50000))
    expect(await projectLiquidity(migrated.db, generalReserveId)).toBe(
      reserveBalanceBefore - rupees(50000),
    )
    // Transfer must NEVER count as recognized income (Invariant 18/53).
    expect(await recognizedIncome(migrated.db, projectId)).toBe(0)
  })

  // --------------------------------------------------------------
  // 6, 7, 8, 9. Custody lifecycle (Scenario F)
  // --------------------------------------------------------------
  describe('6-9. Member cash custody lifecycle (Scenario F)', () => {
    it('6. INTERNAL_CASH_DISBURSEMENT creates custody and reduces project liquidity exactly once', async () => {
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
      expect(await projectLiquidity(migrated.db, projectId)).toBe(0)
    })

    it('7. custody-linked EXPENSE_DIRECT consumes custody without touching project liquidity again', async () => {
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

      expect(
        spend.recognized_amount_minor_units ?? spend.amount_minor_units,
      ).toBe(rupees(25000))
      expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
        rupees(5000),
      )
      // Liquidity was already reduced once at disbursement -- must not
      // be reduced again by the custody-linked spend.
      expect(await projectLiquidity(migrated.db, projectId)).toBe(0)
      expect(await recognizedExpense(migrated.db, projectId)).toBe(
        rupees(25000),
      )
    })

    it('8. custody-linked EXPENSE_SETTLEMENT consumes custody and recognizes expense without a second liquidity deduction', async () => {
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

      expect(settlement.recognized_amount_minor_units).toBe(rupees(25000))
      expect(await custodyBalance(migrated.db, disbursement.id)).toBe(
        rupees(5000),
      )
      expect(await projectLiquidity(migrated.db, projectId)).toBe(0)
      expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
        rupees(5000),
      )
    })

    it('9. Scenario F: INTERNAL_CASH_RETURN of ₹5,000 restores liquidity and zeroes custody', async () => {
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

      expect(ret.status).toBe('POSTED')
      expect(await custodyBalance(migrated.db, disbursement.id)).toBe(0)
      expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(5000))
      // Not income (Invariant 11).
      expect(await recognizedIncome(migrated.db, projectId)).toBe(0)
    })
  })

  // --------------------------------------------------------------
  // 10. Reversal (Scenario N / P)
  // --------------------------------------------------------------
  it('10. Scenario N: reversing a complex settlement fully restores prior state', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(100000),
    })
    const commitmentId = await createCommitment(
      migrated.db,
      projectId,
      expenseCategoryId,
      'OUTFLOW',
      rupees(100000),
      'Stage Vendor',
    )
    const settlement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('settlement'),
      transaction_type: 'EXPENSE_SETTLEMENT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(70000),
      recognized_amount_minor_units: rupees(100000),
      commitment_id: commitmentId,
    })

    // Before reversal.
    expect(await recognizedExpense(migrated.db, projectId)).toBe(rupees(100000))
    expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
      rupees(30000),
    )
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(30000))

    const reversal = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: settlement.id,
    })

    expect(reversal.source_project_id).toBe(projectId)
    expect(reversal.commitment_id).toBe(commitmentId)

    // Fully restored: net financial state = as if the settlement never happened.
    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)
    expect(await commitmentOutstanding(migrated.db, commitmentId)).toBe(
      rupees(100000),
    )
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(100000))
  })

  it('reversal does not create phantom physical cash (Scenario O): reversing a non-cash-linked expense does not fabricate a cash return', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(50000),
    })
    const expense = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('expense'),
      transaction_type: 'EXPENSE_DIRECT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(20000),
    })

    const reversal = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('reverse'),
      transaction_type: 'REVERSAL',
      created_by_user_id: userId,
      reverses_transaction_id: expense.id,
    })

    // The reversal's cash movement exactly matches the original's
    // inverse (project liquidity restored) -- it does not touch
    // custody or fabricate any additional cash event.
    expect(reversal.custody_advance_transaction_id).toBeNull()
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(50000))
  })

  // --------------------------------------------------------------
  // 11. Idempotent duplicate submission (Scenario M)
  // --------------------------------------------------------------
  it('11. Scenario M: a repeated submission with the same idempotency key creates exactly one transaction', async () => {
    const key = uniqueKey('duplicate')
    const donor = await createUser(migrated.db, 'donor2')

    const first = await postTransaction(migrated.db, {
      idempotency_key: key,
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(5000),
      donor_user_id: donor,
    })

    const second = await postTransaction(migrated.db, {
      idempotency_key: key,
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(5000),
      donor_user_id: donor,
    })

    expect(second.id).toBe(first.id)
    expect(await recognizedIncome(migrated.db, projectId)).toBe(rupees(5000))

    const count = await migrated.db.query<{ count: string }>(
      `select count(*)::text as count from transactions where idempotency_key = $1`,
      [key],
    )
    expect(count.rows[0]?.count).toBe('1')
  })

  // --------------------------------------------------------------
  // 12. Invalid transaction routing
  // --------------------------------------------------------------
  it('12. rejects DONATION_MEMBER with no donor_user_id (structural CHECK, invoked through the RPC)', async () => {
    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('bad-donation'),
        transaction_type: 'DONATION_MEMBER',
        created_by_user_id: userId,
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
      }),
    ).rejects.toThrow()
  })

  // --------------------------------------------------------------
  // 13. Invalid commitment direction
  // --------------------------------------------------------------
  it('13. rejects EXPENSE_ADVANCE against an INFLOW commitment', async () => {
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(50000),
    })
    const incomeCategory = await createCategory(
      migrated.db,
      projectId,
      'Auction',
      'INCOME',
    )
    const pledgeId = await createCommitment(
      migrated.db,
      projectId,
      incomeCategory,
      'INFLOW',
      rupees(50000),
    )

    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('bad-direction'),
        transaction_type: 'EXPENSE_ADVANCE',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(10000),
        commitment_id: pledgeId,
      }),
    ).rejects.toThrow(/Commitment Direction/)
  })

  // --------------------------------------------------------------
  // 14. Commitment boundary
  // --------------------------------------------------------------
  it('14. rejects a settlement that would exceed the outstanding commitment amount', async () => {
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
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('advance'),
      transaction_type: 'EXPENSE_ADVANCE',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(70000),
      commitment_id: commitmentId,
    })

    // Outstanding is now ₹30,000; attempting to settle ₹40,000 must fail.
    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('over-settle'),
        transaction_type: 'EXPENSE_SETTLEMENT',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(40000),
        recognized_amount_minor_units: rupees(40000),
        commitment_id: commitmentId,
      }),
    ).rejects.toThrow(/Commitment Settlement Bound/)

    // Exactly ₹30,000 (the remaining outstanding amount) must succeed.
    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('exact-settle'),
        transaction_type: 'EXPENSE_SETTLEMENT',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(30000),
        recognized_amount_minor_units: rupees(30000),
        commitment_id: commitmentId,
      }),
    ).resolves.toBeDefined()
  })

  // --------------------------------------------------------------
  // 15. Custody boundary
  // --------------------------------------------------------------
  it('15. rejects a custody-linked spend that would exceed the outstanding custody balance', async () => {
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

    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('over-spend'),
        transaction_type: 'EXPENSE_DIRECT',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(30001),
        custody_advance_transaction_id: disbursement.id,
        cash_handler_user_id: userId,
      }),
    ).rejects.toThrow(/Custody/)

    // Exactly the outstanding balance must succeed.
    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('exact-spend'),
        transaction_type: 'EXPENSE_DIRECT',
        created_by_user_id: userId,
        source_project_id: projectId,
        amount_minor_units: rupees(30000),
        custody_advance_transaction_id: disbursement.id,
        cash_handler_user_id: userId,
      }),
    ).resolves.toBeDefined()
  })

  // --------------------------------------------------------------
  // 16. Liquidity boundary (General Reserve anti-overdraw, Scenario L's bound)
  // --------------------------------------------------------------
  it('16. rejects a transfer that would overdraw the source project', async () => {
    // Use a dedicated, precisely-funded ordinary project as the
    // transfer source rather than General Reserve, so the boundary
    // is exact and independent of the beforeEach seed amount.
    // (General Reserve may only receive funds via
    // INTERNAL_FUND_TRANSFER, never a direct DONATION_ -- see
    // seedGeneralReserve's doc comment.)
    const sourceProjectId = await createProject(migrated.db, 'Overdraw Source')
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('seed'),
      transaction_type: 'DONATION_PUBLIC',
      created_by_user_id: userId,
      destination_project_id: sourceProjectId,
      amount_minor_units: rupees(50000),
    })

    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('overdraw'),
        transaction_type: 'INTERNAL_FUND_TRANSFER',
        created_by_user_id: userId,
        source_project_id: sourceProjectId,
        destination_project_id: projectId,
        amount_minor_units: rupees(50001),
      }),
    ).rejects.toThrow()

    expect(await projectLiquidity(migrated.db, sourceProjectId)).toBe(
      rupees(50000),
    )

    // Exactly the available balance must succeed.
    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('exact-transfer'),
        transaction_type: 'INTERNAL_FUND_TRANSFER',
        created_by_user_id: userId,
        source_project_id: sourceProjectId,
        destination_project_id: projectId,
        amount_minor_units: rupees(50000),
      }),
    ).resolves.toBeDefined()
    expect(await projectLiquidity(migrated.db, sourceProjectId)).toBe(0)
  })

  // --------------------------------------------------------------
  // 18. Pledge != receipt (also see test #2 above)
  // --------------------------------------------------------------
  it('18. an unpaid pledge never satisfies a liquidity check, even after partial payment', async () => {
    const incomeCategory = await createCategory(
      migrated.db,
      projectId,
      'Auction',
      'INCOME',
    )
    const pledgeId = await createCommitment(
      migrated.db,
      projectId,
      incomeCategory,
      'INFLOW',
      rupees(75000),
    )
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('partial'),
      transaction_type: 'DONATION_AUCTION',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(30000),
      commitment_id: pledgeId,
    })

    // Only the ₹30,000 actually received is liquidity/income -- the
    // remaining ₹45,000 pledge is not, no matter how it is queried.
    expect(await projectLiquidity(migrated.db, projectId)).toBe(rupees(30000))
    expect(await recognizedIncome(migrated.db, projectId)).toBe(rupees(30000))
    expect(await commitmentOutstanding(migrated.db, pledgeId)).toBe(
      rupees(45000),
    )
  })

  // --------------------------------------------------------------
  // 19. Commitment != expense (Scenario D again, isolated assertion)
  // --------------------------------------------------------------
  it('19. an OUTFLOW commitment alone (no transaction posted) creates no recognized expense', async () => {
    await createCommitment(
      migrated.db,
      projectId,
      expenseCategoryId,
      'OUTFLOW',
      rupees(100000),
    )

    expect(await recognizedExpense(migrated.db, projectId)).toBe(0)
    expect(await netPerformance(migrated.db, projectId)).toBe(0)
  })

  // --------------------------------------------------------------
  // Invariant 12: Bounded Cash Return (RPC-level, closing a gap not
  // covered above -- test 15 only exercised the EXPENSE_DIRECT
  // custody-spend bound, not the INTERNAL_CASH_RETURN bound itself).
  // --------------------------------------------------------------
  it('Invariant 12: rejects an INTERNAL_CASH_RETURN that would exceed the outstanding custody balance', async () => {
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
    // Outstanding custody is now ₹5,000.

    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('over-return'),
        transaction_type: 'INTERNAL_CASH_RETURN',
        created_by_user_id: userId,
        destination_project_id: projectId,
        amount_minor_units: rupees(5001),
        custody_advance_transaction_id: disbursement.id,
        cash_handler_user_id: userId,
      }),
    ).rejects.toThrow(/Custody/)

    // Exactly the outstanding balance must succeed.
    await expect(
      postTransaction(migrated.db, {
        idempotency_key: uniqueKey('exact-return'),
        transaction_type: 'INTERNAL_CASH_RETURN',
        created_by_user_id: userId,
        destination_project_id: projectId,
        amount_minor_units: rupees(5000),
        custody_advance_transaction_id: disbursement.id,
        cash_handler_user_id: userId,
      }),
    ).resolves.toBeDefined()
    expect(await custodyBalance(migrated.db, disbursement.id)).toBe(0)
  })

  // --------------------------------------------------------------
  // Invariants 47/48/49: Donor / Handler / Approver actor
  // independence -- explicit assertions that these identities are
  // stored independently of the transaction creator, not merely
  // "happens to differ in other tests".
  // --------------------------------------------------------------
  it('Invariants 47-49: donor, cash handler, and approver identities are stored independently of the creator', async () => {
    const donor = await createUser(migrated.db, 'donor-independence')
    const approver = await createUser(migrated.db, 'approver-independence')

    // 47: donor_user_id independent of created_by_user_id.
    const donation = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('donor-independence'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: userId, // Suresh enters it
      destination_project_id: projectId,
      amount_minor_units: rupees(5000),
      donor_user_id: donor, // Ravi donates
      approved_by_user_id: approver,
    })
    expect(donation.created_by_user_id).toBe(userId)
    expect(donation.donor_user_id).toBe(donor)
    expect(donation.donor_user_id).not.toBe(donation.created_by_user_id)

    // 48: cash_handler_user_id independent of created_by_user_id.
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('fund'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(10000),
    })
    const handler = await createUser(migrated.db, 'handler-independence')
    const disbursement = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('handler-independence'),
      transaction_type: 'INTERNAL_CASH_DISBURSEMENT',
      created_by_user_id: userId, // Suresh records it
      source_project_id: projectId,
      amount_minor_units: rupees(10000),
      cash_handler_user_id: handler, // Ravi receives custody
    })
    expect(disbursement.created_by_user_id).toBe(userId)
    expect(disbursement.cash_handler_user_id).toBe(handler)
    expect(disbursement.cash_handler_user_id).not.toBe(
      disbursement.created_by_user_id,
    )

    // 49: approved_by_user_id independent of created_by_user_id
    // (already structurally required by chk_tx_maker_checker; this
    // asserts the RPC actually persists a distinct approver).
    expect(donation.approved_by_user_id).toBe(approver)
    expect(donation.approved_by_user_id).not.toBe(donation.created_by_user_id)
  })

  // --------------------------------------------------------------
  // Invariant 46: Reserve Ledger Traceability -- every General
  // Reserve transfer identifies a specific source/destination.
  // --------------------------------------------------------------
  it('Invariant 46: every General Reserve transfer is traceable to a specific source/destination project', async () => {
    const transfer = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('gr-traceable'),
      transaction_type: 'INTERNAL_FUND_TRANSFER',
      created_by_user_id: userId,
      source_project_id: generalReserveId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
    })

    expect(transfer.source_project_id).toBe(generalReserveId)
    expect(transfer.destination_project_id).toBe(projectId)

    const traced = await migrated.db.query<{
      source_project_id: string
      destination_project_id: string
    }>(
      `select source_project_id, destination_project_id
         from financial_effects
        where transaction_id = $1`,
      [transfer.id],
    )
    expect(traced.rows[0]?.source_project_id).toBe(generalReserveId)
    expect(traced.rows[0]?.destination_project_id).toBe(projectId)
  })

  // --------------------------------------------------------------
  // Invariants 33/51/52: Liquidity Traceability -- every liquidity
  // figure is drillable to underlying POSTED transactions; no amount
  // appears/disappears without an attributable transaction.
  // --------------------------------------------------------------
  it('Invariants 33/51/52: project liquidity is exactly the sum of its underlying POSTED transaction effects', async () => {
    const donor = await createUser(migrated.db, 'donor-traceability')
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('trace-donation'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: userId,
      destination_project_id: projectId,
      amount_minor_units: rupees(20000),
      donor_user_id: donor,
    })
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('trace-expense'),
      transaction_type: 'EXPENSE_DIRECT',
      created_by_user_id: userId,
      source_project_id: projectId,
      amount_minor_units: rupees(8000),
    })

    const drilldown = await migrated.db.query<{ total: string }>(
      `select coalesce(sum(
         case when destination_project_id = $1 then dest_liquidity else 0 end
         + case when source_project_id = $1 then src_liquidity else 0 end
       ), 0)::text as total
       from financial_effects
       where status = 'POSTED'
         and (source_project_id = $1 or destination_project_id = $1)`,
      [projectId],
    )

    expect(Number(drilldown.rows[0]?.total)).toBe(rupees(12000))
    expect(await projectLiquidity(migrated.db, projectId)).toBe(
      Number(drilldown.rows[0]?.total),
    )
  })
})
