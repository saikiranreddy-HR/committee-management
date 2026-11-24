import type { PGlite } from '@electric-sql/pglite'

import {
  clearAuthContext,
  setAuthContext,
} from '../helpers/apply-migrations.js'

export interface TransactionRow {
  id: string
  source_project_id: string | null
  destination_project_id: string | null
  category_id: string | null
  commitment_id: string | null
  custody_advance_transaction_id: string | null
  reverses_transaction_id: string | null
  transaction_type: string
  description: string
  amount_minor_units: number
  recognized_amount_minor_units: number | null
  payment_source: string
  donor_user_id: string | null
  cash_handler_user_id: string | null
  status: string
  created_by_user_id: string
  approved_by_user_id: string | null
  void_reason: string | null
  idempotency_key: string
}

export interface PostTransactionParams {
  idempotency_key: string
  transaction_type: string
  created_by_user_id: string
  amount_minor_units?: number
  recognized_amount_minor_units?: number
  source_project_id?: string
  destination_project_id?: string
  category_id?: string
  commitment_id?: string
  custody_advance_transaction_id?: string
  reverses_transaction_id?: string
  donor_user_id?: string
  cash_handler_user_id?: string
  payment_source?: string
  description?: string
  approved_by_user_id?: string
  void_reason?: string
}

/**
 * Calls the `financial_post_transaction` RPC using PostgreSQL's named
 * argument syntax (`p_name => $n`), so any subset of the optional
 * parameters can be supplied without worrying about positional order.
 *
 * Phase 2D: the RPC now requires a real authenticated session
 * (`auth.uid()` must resolve, and the caller must hold ACCOUNTANT or
 * ADMIN). This helper transparently authenticates the PGlite session
 * AS `params.created_by_user_id` for the duration of the call (this
 * is what keeps every pre-Phase-2D test working unchanged: they
 * already pass a real, role-bearing user as the creator -- see
 * `createUser`'s default role below), then restores the session to
 * its neutral/superuser default afterward so surrounding assertions
 * (which query derived state directly, not "as" any particular user)
 * are unaffected. Tests that want to deliberately authenticate as a
 * DIFFERENT user than `created_by_user_id` (e.g. to prove
 * impersonation is rejected) should use `postTransactionAs` instead.
 */
export async function postTransaction(
  db: PGlite,
  params: PostTransactionParams,
): Promise<TransactionRow> {
  return postTransactionAs(db, params.created_by_user_id, params)
}

/**
 * Same as `postTransaction`, but authenticates the session as
 * `authenticatedUserId` rather than `params.created_by_user_id` --
 * use this to test the RPC's actor-identity consistency check
 * (Phase 2D) with a deliberately mismatched identity.
 */
export async function postTransactionAs(
  db: PGlite,
  authenticatedUserId: string,
  params: PostTransactionParams,
): Promise<TransactionRow> {
  const keys = Object.keys(params) as (keyof PostTransactionParams)[]
  const assignments = keys.map((key, i) => `p_${key} => $${i + 1}`).join(', ')
  const values = keys.map((key) => params[key])

  await setAuthContext(db, authenticatedUserId)
  try {
    const result = await db.query<TransactionRow>(
      `select * from financial_post_transaction(${assignments})`,
      values,
    )
    const row = result.rows[0]
    if (!row) {
      throw new Error('financial_post_transaction returned no row')
    }
    return row
  } finally {
    await clearAuthContext(db)
  }
}

let counter = 0
export function uniqueKey(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${Date.now()}`
}

/**
 * Creates a committee user. Defaults to the `ACCOUNTANT` role (the
 * minimum role able to post financial transactions, per §12.1's
 * capability matrix) so that every test written before Phase 2D
 * continues to work unchanged -- they all assumed any created user
 * could post transactions. Pass `roles: []` for a user with no role
 * (e.g. to test that an un-roled/MEMBER-only user is correctly
 * rejected), or `roles: ['MEMBER']` / `['AUDITOR']` / `['ADMIN']` /
 * any combination to test a specific role boundary.
 */
export async function createUser(
  db: PGlite,
  username: string,
  roles: string[] = ['ACCOUNTANT'],
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into users (id, username, display_name, created_at)
     values (gen_random_uuid(), $1, $1, now())
     returning id`,
    [username],
  )
  const userId = result.rows[0]!.id

  for (const role of roles) {
    await db.query(`insert into user_roles (user_id, role) values ($1, $2)`, [
      userId,
      role,
    ])
  }

  return userId
}

export async function createProject(
  db: PGlite,
  name: string,
  status = 'ACTIVE',
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into projects (name, type, start_date, end_date, status, client_timestamp)
     values ($1, 'FESTIVAL', now(), now(), $2, now())
     returning id`,
    [name, status],
  )
  return result.rows[0]!.id
}

export async function getGeneralReserveId(db: PGlite): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select id from projects where is_general_reserve = true`,
  )
  return result.rows[0]!.id
}

/**
 * Seeds General Reserve with funds for test setup. General Reserve
 * may only participate in INTERNAL_FUND_TRANSFER transactions (§6
 * General Reserve Protection Invariant) -- it can never be the direct
 * destination of a DONATION_*. This helper respects that rule exactly
 * as the RPC enforces it: it creates a throwaway ordinary project,
 * funds that via an ordinary donation, then transfers the funds into
 * General Reserve via INTERNAL_FUND_TRANSFER -- the only legitimate
 * path into General Reserve.
 */
export async function seedGeneralReserve(
  db: PGlite,
  generalReserveId: string,
  amountMinorUnits: number,
  createdByUserId: string,
): Promise<void> {
  const seedProjectId = await createProject(db, `Seed Source ${uniqueKey('p')}`)
  await postTransaction(db, {
    idempotency_key: uniqueKey('seed-donation'),
    transaction_type: 'DONATION_PUBLIC',
    created_by_user_id: createdByUserId,
    destination_project_id: seedProjectId,
    amount_minor_units: amountMinorUnits,
  })
  await postTransaction(db, {
    idempotency_key: uniqueKey('seed-transfer'),
    transaction_type: 'INTERNAL_FUND_TRANSFER',
    created_by_user_id: createdByUserId,
    source_project_id: seedProjectId,
    destination_project_id: generalReserveId,
    amount_minor_units: amountMinorUnits,
  })
}

export async function createCategory(
  db: PGlite,
  projectId: string,
  name: string,
  categoryType: 'EXPENSE' | 'INCOME' = 'EXPENSE',
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into project_categories (project_id, name, category_type)
     values ($1, $2, $3)
     returning id`,
    [projectId, name, categoryType],
  )
  return result.rows[0]!.id
}

export async function createCommitment(
  db: PGlite,
  projectId: string,
  categoryId: string,
  direction: 'INFLOW' | 'OUTFLOW',
  committedAmountMinorUnits: number,
  partyName = 'Vendor',
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into commitments (project_id, category_id, direction, party_name, committed_amount_minor_units)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [projectId, categoryId, direction, partyName, committedAmountMinorUnits],
  )
  return result.rows[0]!.id
}

export async function projectLiquidity(
  db: PGlite,
  projectId: string,
): Promise<number> {
  const result = await db.query<{ liquidity: string }>(
    `select financial_project_liquidity($1)::text as liquidity`,
    [projectId],
  )
  return Number(result.rows[0]!.liquidity)
}

export async function custodyBalance(
  db: PGlite,
  disbursementId: string,
): Promise<number> {
  const result = await db.query<{ balance: string }>(
    `select financial_custody_balance($1)::text as balance`,
    [disbursementId],
  )
  return Number(result.rows[0]!.balance)
}

export async function commitmentOutstanding(
  db: PGlite,
  commitmentId: string,
): Promise<number> {
  const result = await db.query<{ outstanding: string }>(
    `select financial_commitment_outstanding($1)::text as outstanding`,
    [commitmentId],
  )
  return Number(result.rows[0]!.outstanding)
}

export async function recognizedIncome(
  db: PGlite,
  projectId: string,
): Promise<number> {
  const result = await db.query<{ value: string }>(
    `select financial_recognized_income($1)::text as value`,
    [projectId],
  )
  return Number(result.rows[0]!.value)
}

export async function recognizedExpense(
  db: PGlite,
  projectId: string,
): Promise<number> {
  const result = await db.query<{ value: string }>(
    `select financial_recognized_expense($1)::text as value`,
    [projectId],
  )
  return Number(result.rows[0]!.value)
}

export async function netPerformance(
  db: PGlite,
  projectId: string,
): Promise<number> {
  const result = await db.query<{ value: string }>(
    `select financial_net_performance($1)::text as value`,
    [projectId],
  )
  return Number(result.rows[0]!.value)
}

/** ₹ to paise (integer minor units), matching the architecture's worked examples exactly. */
export function rupees(amount: number): number {
  return Math.round(amount * 100)
}
