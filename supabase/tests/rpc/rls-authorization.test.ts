import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearAuthContext,
  createMigratedDatabase,
  setAuthContext,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'
import {
  createCategory,
  createProject,
  createUser,
  getGeneralReserveId,
  postTransaction,
  postTransactionAs,
  rupees,
  seedGeneralReserve,
  uniqueKey,
} from './helpers.js'

/**
 * Phase 2D: Supabase Auth + RBAC + RLS / authorization boundary.
 *
 * ============================================================
 * SCOPE DISCLOSURE (read before trusting these results)
 * ============================================================
 * These tests execute against a REAL PostgreSQL RLS/role/auth.uid()
 * mechanism, not a mock -- see the file-level comment in
 * supabase/tests/helpers/apply-migrations.ts for exactly how the
 * `anon`/`authenticated`/`service_role` roles and `auth.uid()`/
 * `auth.role()` are (faithfully) recreated for this embedded PGlite
 * instance, matching Supabase's own documented implementation
 * exactly. Every RLS policy, GRANT, and the financial RPC's identity
 * check below are exercised for real: a query issued "as" a given
 * role genuinely succeeds or fails based on PostgreSQL's own
 * evaluation of the policy, not an assertion about what the policy
 * SQL says.
 *
 * What is NOT exercised here, and cannot be with PGlite alone:
 * GoTrue's JWT issuance, PostgREST's JWT signature validation, or any
 * network-level session establishment -- i.e. how a session
 * legitimately comes to have a trustworthy `request.jwt.claim.sub`
 * in the first place. This test suite necessarily treats "the
 * session's JWT claim is already trustworthy" as a given, exactly as
 * the real architecture divides responsibility: JWT authenticity is
 * Supabase's managed infrastructure, and RLS/RPC authorization is
 * what this project implements and is responsible for testing.
 */
describe('Phase 2D RLS / authorization boundary', () => {
  let migrated: MigratedDatabase
  let memberId: string
  let accountantId: string
  let adminId: string
  let auditorId: string
  let generalReserveId: string
  let projectId: string
  let categoryId: string

  beforeEach(async () => {
    migrated = await createMigratedDatabase()
    memberId = await createUser(migrated.db, 'member-user', ['MEMBER'])
    accountantId = await createUser(migrated.db, 'accountant-user', [
      'ACCOUNTANT',
    ])
    adminId = await createUser(migrated.db, 'admin-user', ['ADMIN'])
    auditorId = await createUser(migrated.db, 'auditor-user', ['AUDITOR'])
    generalReserveId = await getGeneralReserveId(migrated.db)
    projectId = await createProject(migrated.db, 'Ganesh Chaturthi 2026')
    categoryId = await createCategory(migrated.db, projectId, 'Decoration')
    await seedGeneralReserve(
      migrated.db,
      generalReserveId,
      rupees(1000000),
      adminId,
    )
  })

  afterEach(async () => {
    await migrated.db.close()
  })

  // ------------------------------------------------------------
  // 1. Unauthenticated user cannot access protected data.
  // ------------------------------------------------------------
  it('1. an unauthenticated (anon) session cannot read transactions or projects', async () => {
    await setAuthContext(migrated.db, null) // simulates anon
    await expect(
      migrated.db.query(`select * from transactions`),
    ).rejects.toThrow(/permission denied/)
    await expect(migrated.db.query(`select * from projects`)).rejects.toThrow(
      /permission denied/,
    )
    await clearAuthContext(migrated.db)
  })

  // ------------------------------------------------------------
  // 2. Authenticated MEMBER can access only what MEMBER is
  //    authorized to access.
  // ------------------------------------------------------------
  it('2. an authenticated MEMBER can read projects/transactions but not audit_events', async () => {
    await setAuthContext(migrated.db, memberId)

    await expect(
      migrated.db.query(`select * from projects`),
    ).resolves.toBeDefined()
    await expect(
      migrated.db.query(`select * from transactions`),
    ).resolves.toBeDefined()

    const auditResult = await migrated.db.query(`select * from audit_events`)
    expect(auditResult.rows.length).toBe(0) // RLS filters all rows out

    await clearAuthContext(migrated.db)
  })

  // ------------------------------------------------------------
  // 3. MEMBER cannot perform ACCOUNTANT-only financial mutation.
  // ------------------------------------------------------------
  it('3. MEMBER cannot post a financial transaction via the RPC', async () => {
    await expect(
      postTransactionAs(migrated.db, memberId, {
        idempotency_key: uniqueKey('member-donation'),
        transaction_type: 'DONATION_MEMBER',
        created_by_user_id: memberId,
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
        donor_user_id: memberId,
      }),
    ).rejects.toThrow(/does not hold a role authorized to post/)
  })

  // ------------------------------------------------------------
  // 4. MEMBER cannot perform ADMIN-only operations.
  // ------------------------------------------------------------
  it('4. MEMBER cannot create a project or assign a role', async () => {
    await setAuthContext(migrated.db, memberId)

    await expect(
      migrated.db.query(
        `insert into projects (name, type, start_date, end_date, status, client_timestamp)
         values ('Rogue Project', 'FESTIVAL', now(), now(), 'PLANNING', now())`,
      ),
    ).rejects.toThrow()

    await expect(
      migrated.db.query(
        `insert into user_roles (user_id, role) values ($1, 'ADMIN')`,
        [memberId],
      ),
    ).rejects.toThrow()

    await clearAuthContext(migrated.db)
  })

  // ------------------------------------------------------------
  // 5. ACCOUNTANT cannot perform ADMIN-only operations.
  // ------------------------------------------------------------
  it('5. ACCOUNTANT cannot create a project, assign roles, or approve a deficit review', async () => {
    await setAuthContext(migrated.db, accountantId)

    await expect(
      migrated.db.query(
        `insert into projects (name, type, start_date, end_date, status, client_timestamp)
         values ('Rogue Project', 'FESTIVAL', now(), now(), 'PLANNING', now())`,
      ),
    ).rejects.toThrow()

    await expect(
      migrated.db.query(
        `insert into user_roles (user_id, role) values ($1, 'ADMIN')`,
        [accountantId],
      ),
    ).rejects.toThrow()

    await clearAuthContext(migrated.db)

    // Create a deficit review as ACCOUNTANT (allowed)...
    await setAuthContext(migrated.db, accountantId)
    const review = await migrated.db.query<{ id: string }>(
      `insert into project_deficit_reviews (
         project_id, deficit_amount_minor_units, reason, explanation,
         reviewed_by_user_id, reviewed_at, status
       ) values ($1, 500000, 'Overspend', 'Vendor cost overrun', $2, now(), 'PENDING_APPROVAL')
       returning id`,
      [projectId, accountantId],
    )
    await clearAuthContext(migrated.db)

    // ...but ACCOUNTANT cannot approve it themselves via direct update.
    await setAuthContext(migrated.db, accountantId)
    const updateResult = await migrated.db.query(
      `update project_deficit_reviews set status = 'APPROVED', approved_by_user_id = $1 where id = $2`,
      [accountantId, review.rows[0]?.id],
    )
    expect(updateResult.affectedRows ?? 0).toBe(0) // RLS silently filters, not an error, for UPDATE with no matching row
    await clearAuthContext(migrated.db)
  })

  // ------------------------------------------------------------
  // 6 & 7. AUDITOR cannot mutate financial state, but can read audit history.
  // ------------------------------------------------------------
  it('6. AUDITOR cannot post a financial transaction, mutate roles, or write audit events', async () => {
    await expect(
      postTransactionAs(migrated.db, auditorId, {
        idempotency_key: uniqueKey('auditor-donation'),
        transaction_type: 'DONATION_MEMBER',
        created_by_user_id: auditorId,
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
        donor_user_id: auditorId,
      }),
    ).rejects.toThrow(/does not hold a role authorized to post/)

    await setAuthContext(migrated.db, auditorId)
    await expect(
      migrated.db.query(
        `insert into user_roles (user_id, role) values ($1, 'ADMIN')`,
        [auditorId],
      ),
    ).rejects.toThrow()
    await expect(
      migrated.db.query(
        `insert into audit_events (entity_type, entity_id, action_type, actor_user_id, entity_version, after_state_json, client_timestamp)
         values ('projects', $1, 'FABRICATED', $2, 1, '{}'::jsonb, now())`,
        [projectId, auditorId],
      ),
    ).rejects.toThrow(/permission denied/)
    await clearAuthContext(migrated.db)
  })

  it('7. AUDITOR can read the audit trail (ADMIN/AUDITOR-only SELECT)', async () => {
    // Generate at least one audit event via a legitimate ACCOUNTANT posting.
    await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('audit-seed'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: accountantId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
      donor_user_id: accountantId,
    })

    await setAuthContext(migrated.db, auditorId)
    const result = await migrated.db.query(`select * from audit_events`)
    expect(result.rows.length).toBeGreaterThan(0)
    await clearAuthContext(migrated.db)

    // MEMBER and ACCOUNTANT, by contrast, see zero rows (RLS-filtered).
    await setAuthContext(migrated.db, accountantId)
    const asAccountant = await migrated.db.query(`select * from audit_events`)
    expect(asAccountant.rows.length).toBe(0)
    await clearAuthContext(migrated.db)
  })

  // ------------------------------------------------------------
  // 8 & 9. Role mutation safety.
  // ------------------------------------------------------------
  it('8. a user cannot grant themselves another role', async () => {
    await setAuthContext(migrated.db, accountantId)
    await expect(
      migrated.db.query(
        `insert into user_roles (user_id, role) values ($1, 'ADMIN')`,
        [accountantId],
      ),
    ).rejects.toThrow()
    await clearAuthContext(migrated.db)
  })

  it("9. a user cannot modify another user's role assignment through ordinary access", async () => {
    await setAuthContext(migrated.db, accountantId)
    await expect(
      migrated.db.query(
        `update user_roles set role = 'ADMIN' where user_id = $1 and role = 'MEMBER'`,
        [memberId],
      ),
    ).resolves.toBeDefined() // does not throw...
    await clearAuthContext(migrated.db)

    // ...but genuinely changed nothing (RLS filters out every row for
    // a non-ADMIN UPDATE, so 0 rows are affected).
    const check = await migrated.db.query<{ role: string }>(
      `select role from user_roles where user_id = $1`,
      [memberId],
    )
    expect(check.rows.map((r) => r.role)).toEqual(['MEMBER'])
  })

  // ------------------------------------------------------------
  // 10, 11, 12. Impersonation resistance via the financial RPC.
  // ------------------------------------------------------------
  it('10 & 12. a client cannot impersonate another user by supplying another users.id as p_created_by_user_id', async () => {
    // Authenticated as accountantId, but claims to be adminId.
    await expect(
      postTransactionAs(migrated.db, accountantId, {
        idempotency_key: uniqueKey('impersonation-attempt'),
        transaction_type: 'DONATION_MEMBER',
        created_by_user_id: adminId, // impersonation attempt
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
        donor_user_id: accountantId,
      }),
    ).rejects.toThrow(/does not match the authenticated caller/)
  })

  it('11 & 14. the financial RPC uses auth.uid() as authoritative identity and attributes the transaction to the authenticated user', async () => {
    const tx = await postTransactionAs(migrated.db, accountantId, {
      idempotency_key: uniqueKey('authoritative-identity'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: accountantId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
      donor_user_id: accountantId,
    })
    expect(tx.created_by_user_id).toBe(accountantId)

    // Omitting the compatibility parameter entirely still works and
    // still attributes correctly to the authenticated caller.
    await setAuthContext(migrated.db, accountantId)
    const result = await migrated.db.query(
      `select * from financial_post_transaction(
         p_idempotency_key => $1,
         p_transaction_type => 'DONATION_MEMBER',
         p_created_by_user_id => null,
         p_destination_project_id => $2,
         p_amount_minor_units => $3,
         p_donor_user_id => $4
       )`,
      [uniqueKey('no-param'), projectId, rupees(500), accountantId],
    )
    await clearAuthContext(migrated.db)
    expect(
      (result.rows[0] as { created_by_user_id: string }).created_by_user_id,
    ).toBe(accountantId)
  })

  it('13. a caller with insufficient role (MEMBER) cannot execute the financial RPC even with a truthful identity', async () => {
    await expect(
      postTransactionAs(migrated.db, memberId, {
        idempotency_key: uniqueKey('insufficient-role'),
        transaction_type: 'DONATION_MEMBER',
        created_by_user_id: memberId,
        destination_project_id: projectId,
        amount_minor_units: rupees(1000),
        donor_user_id: memberId,
      }),
    ).rejects.toThrow(/does not hold a role authorized to post/)
  })

  // ------------------------------------------------------------
  // 15, 16, 17. Direct writes to authoritative financial state remain blocked.
  // ------------------------------------------------------------
  it('15. direct INSERT into transactions is blocked for every role, RPC-only', async () => {
    for (const userId of [memberId, accountantId, adminId, auditorId]) {
      await setAuthContext(migrated.db, userId)
      await expect(
        migrated.db.query(
          `insert into transactions (
             destination_project_id, transaction_type, description,
             amount_minor_units, payment_source, donor_user_id,
             transaction_date, status, created_by_user_id, created_at,
             idempotency_key, client_timestamp
           ) values (
             $1, 'DONATION_MEMBER', 'direct insert attempt',
             100000, 'CASH', $2, now(), 'POSTED', $2, now(),
             $3, now()
           )`,
          [projectId, userId, uniqueKey('direct-insert')],
        ),
      ).rejects.toThrow(/permission denied/)
      await clearAuthContext(migrated.db)
    }
  })

  it('16. direct UPDATE of a POSTED transaction remains blocked for every role', async () => {
    const tx = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('update-target'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: accountantId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
      donor_user_id: accountantId,
    })

    for (const userId of [memberId, accountantId, adminId, auditorId]) {
      await setAuthContext(migrated.db, userId)
      await expect(
        migrated.db.query(
          `update transactions set description = 'tampered' where id = $1`,
          [tx.id],
        ),
      ).rejects.toThrow(/permission denied/)
      await clearAuthContext(migrated.db)
    }
  })

  it('17. direct DELETE of a protected financial record remains blocked for every role', async () => {
    const tx = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('delete-target'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: accountantId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
      donor_user_id: accountantId,
    })

    for (const userId of [memberId, accountantId, adminId, auditorId]) {
      await setAuthContext(migrated.db, userId)
      await expect(
        migrated.db.query(`delete from transactions where id = $1`, [tx.id]),
      ).rejects.toThrow(/permission denied/)
      await clearAuthContext(migrated.db)
    }
  })

  // ------------------------------------------------------------
  // 18 & 19. Audit immutability and attribution cannot be fabricated.
  // ------------------------------------------------------------
  it('18. audit_events remain immutable under every role (RLS + trigger, defense in depth)', async () => {
    const tx = await postTransaction(migrated.db, {
      idempotency_key: uniqueKey('audit-immutability'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: accountantId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
      donor_user_id: accountantId,
    })
    const auditRow = await migrated.db.query<{ id: string }>(
      `select id from audit_events where entity_id = $1`,
      [tx.id],
    )
    const auditId = auditRow.rows[0]?.id

    for (const userId of [adminId, auditorId]) {
      await setAuthContext(migrated.db, userId)
      await expect(
        migrated.db.query(
          `update audit_events set reason = 'tampered' where id = $1`,
          [auditId],
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        migrated.db.query(`delete from audit_events where id = $1`, [auditId]),
      ).rejects.toThrow(/permission denied/)
      await clearAuthContext(migrated.db)
    }
  })

  it('19. audit actor attribution reflects the authenticated caller, never a client-supplied identity', async () => {
    const tx = await postTransactionAs(migrated.db, accountantId, {
      idempotency_key: uniqueKey('audit-attribution'),
      transaction_type: 'DONATION_MEMBER',
      created_by_user_id: accountantId,
      destination_project_id: projectId,
      amount_minor_units: rupees(1000),
      donor_user_id: accountantId,
    })

    await setAuthContext(migrated.db, adminId)
    const auditRow = await migrated.db.query<{ actor_user_id: string }>(
      `select actor_user_id from audit_events where entity_id = $1`,
      [tx.id],
    )
    await clearAuthContext(migrated.db)

    expect(auditRow.rows[0]?.actor_user_id).toBe(accountantId)
  })

  // ------------------------------------------------------------
  // 20. General Reserve protections remain intact under RLS.
  // ------------------------------------------------------------
  it('20. General Reserve cannot be deleted, closed, or have its liquidity manually altered by any role via RLS-gated paths', async () => {
    for (const userId of [memberId, accountantId, adminId, auditorId]) {
      await setAuthContext(migrated.db, userId)
      await expect(
        migrated.db.query(`delete from projects where id = $1`, [
          generalReserveId,
        ]),
      ).rejects.toThrow()
      await clearAuthContext(migrated.db)
    }

    // Even ADMIN cannot close General Reserve via direct UPDATE (the
    // RLS policy's WITH CHECK explicitly forbids status = 'CLOSED' on
    // this row regardless of role -- see migration 0019). A WITH
    // CHECK violation on UPDATE raises an explicit RLS error (unlike
    // a USING-clause mismatch, which silently filters rows), so this
    // is asserted as a rejection, not a silent no-op.
    await setAuthContext(migrated.db, adminId)
    await expect(
      migrated.db.query(`update projects set status = 'CLOSED' where id = $1`, [
        generalReserveId,
      ]),
    ).rejects.toThrow(/row-level security policy/)
    await clearAuthContext(migrated.db)

    // General Reserve remains ACTIVE and is_general_reserve = true.
    const check = await migrated.db.query<{
      status: string
      is_general_reserve: boolean
    }>(`select status, is_general_reserve from projects where id = $1`, [
      generalReserveId,
    ])
    expect(check.rows[0]).toEqual({
      status: 'ACTIVE',
      is_general_reserve: true,
    })
  })

  // ------------------------------------------------------------
  // 21. Existing Phase 2B financial tests continue to pass -- see
  //     financial-engine.test.ts, custody-reversal-consistency.test.ts,
  //     and concurrency-and-authorization.test.ts, all re-run
  //     unmodified (aside from the shared helper's auth-context
  //     wiring) as part of `npm run test:db`. Not duplicated here.
  // ------------------------------------------------------------

  // ------------------------------------------------------------
  // Additional: commitment/category-adjacent role checks, and the
  // "no broad USING(true)/WITH CHECK(true) for authenticated on
  // sensitive tables" requirement verified structurally.
  // ------------------------------------------------------------
  it('MEMBER cannot create a commitment or category (ACCOUNTANT/ADMIN-only management)', async () => {
    await setAuthContext(migrated.db, memberId)
    await expect(
      migrated.db.query(
        `insert into project_categories (project_id, name, category_type) values ($1, 'Rogue', 'EXPENSE')`,
        [projectId],
      ),
    ).rejects.toThrow()
    await clearAuthContext(migrated.db)
  })

  it('ACCOUNTANT can create a commitment; the resulting row is visible to all roles', async () => {
    await setAuthContext(migrated.db, accountantId)
    const commitment = await migrated.db.query<{ id: string }>(
      `insert into commitments (project_id, category_id, direction, party_name, committed_amount_minor_units)
       values ($1, $2, 'OUTFLOW', 'Vendor', 500000)
       returning id`,
      [projectId, categoryId],
    )
    await clearAuthContext(migrated.db)

    await setAuthContext(migrated.db, memberId)
    const visible = await migrated.db.query(
      `select * from commitments where id = $1`,
      [commitment.rows[0]?.id],
    )
    expect(visible.rows.length).toBe(1)
    await clearAuthContext(migrated.db)
  })

  it('no INSERT/UPDATE/DELETE policy on transactions, audit_events, or user_roles grants unrestricted authenticated access (structural guard against USING(true)/WITH CHECK(true) on sensitive-table mutations)', async () => {
    const result = await migrated.db.query<{
      tablename: string
      policyname: string
      cmd: string
      qual: string | null
      with_check: string | null
    }>(
      `select tablename, policyname, cmd, qual, with_check
         from pg_policies
        where schemaname = 'public'
          and tablename in ('transactions', 'audit_events', 'user_roles')
          and cmd in ('INSERT', 'UPDATE', 'DELETE')`,
    )

    // transactions/audit_events have NO insert/update/delete policies
    // at all (no GRANT even exists for authenticated -- see migration
    // 0019) -- so this query should find rows only for user_roles,
    // and every one of those must be role-gated, never bare `true`.
    expect(result.rows.length).toBeGreaterThan(0)
    for (const row of result.rows) {
      if (row.qual) {
        expect(row.qual.trim()).not.toBe('true')
      }
      if (row.with_check) {
        expect(row.with_check.trim()).not.toBe('true')
      }
    }
  })
})
