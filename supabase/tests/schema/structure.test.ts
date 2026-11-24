import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  listMigrationFileNames,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'

const EXPECTED_TABLES = [
  'users',
  'user_roles',
  'projects',
  'project_categories',
  'vendors',
  'budgets',
  'commitments',
  'food_sessions',
  'project_deficit_reviews',
  'additional_funding_plans',
  'funding_plan_items',
  'transactions',
  'attachment_metadata',
  'audit_events',
  'pooja_configs',
  'pooja_days',
  'pooja_slots',
  'pooja_participants',
  'inventory_items',
  'inventory_movements',
].sort()

interface ColumnRow {
  column_name: string
  data_type: string
  is_nullable: 'YES' | 'NO'
}

async function getColumns(
  db: MigratedDatabase['db'],
  table: string,
): Promise<ColumnRow[]> {
  const result = await db.query<ColumnRow>(
    `select column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  )
  return result.rows
}

function findColumn(rows: ColumnRow[], name: string): ColumnRow {
  const column = rows.find((r) => r.column_name === name)
  if (!column) {
    throw new Error(`Column "${name}" not found`)
  }
  return column
}

describe('Phase 2A schema structure', () => {
  let migrated: MigratedDatabase

  beforeAll(async () => {
    migrated = await createMigratedDatabase()
  })

  afterAll(async () => {
    await migrated.db.close()
  })

  it('applies all migrations to a clean database without error', () => {
    expect(migrated.appliedMigrations).toEqual(listMigrationFileNames())
    expect(migrated.appliedMigrations.length).toBe(20)
  })

  it('creates all 20 required entity tables', async () => {
    const result = await migrated.db.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    )
    const actual = result.rows
      .map((r: { table_name: string }) => r.table_name)
      .sort()
    expect(actual).toEqual(EXPECTED_TABLES)
  })

  describe('identifier columns are UUID', () => {
    it.each([
      ['users', 'id'],
      ['projects', 'id'],
      ['projects', 'cloned_from_project_id'],
      ['transactions', 'id'],
      ['transactions', 'source_project_id'],
      ['transactions', 'reverses_transaction_id'],
      ['transactions', 'custody_advance_transaction_id'],
      ['commitments', 'id'],
      ['audit_events', 'entity_id'],
    ])('%s.%s is uuid', async (table, column) => {
      const columns = await getColumns(migrated.db, table)
      expect(findColumn(columns, column).data_type).toBe('uuid')
    })
  })

  describe('timestamp columns are timestamptz', () => {
    it.each([
      ['users', 'created_at'],
      ['projects', 'start_date'],
      ['projects', 'end_date'],
      ['projects', 'client_timestamp'],
      ['projects', 'server_timestamp'],
      ['transactions', 'transaction_date'],
      ['transactions', 'created_at'],
      ['audit_events', 'client_timestamp'],
      ['audit_events', 'server_timestamp'],
    ])('%s.%s is timestamp with time zone', async (table, column) => {
      const columns = await getColumns(migrated.db, table)
      expect(findColumn(columns, column).data_type).toBe(
        'timestamp with time zone',
      )
    })
  })

  describe('boolean flag columns are boolean', () => {
    it.each([
      ['users', 'is_active'],
      ['projects', 'is_general_reserve'],
      ['projects', 'is_deleted'],
      ['commitments', 'is_cancelled'],
      ['transactions', 'is_deleted'],
      ['attachment_metadata', 'is_purged'],
      ['pooja_slots', 'committee_will_arrange'],
      ['pooja_participants', 'is_committee_arranged'],
    ])('%s.%s is boolean', async (table, column) => {
      const columns = await getColumns(migrated.db, table)
      expect(findColumn(columns, column).data_type).toBe('boolean')
    })
  })

  describe('required nullability is preserved', () => {
    it.each([
      ['users', 'username', 'NO'],
      ['transactions', 'idempotency_key', 'NO'],
      ['transactions', 'created_by_user_id', 'NO'],
      ['transactions', 'recognized_amount_minor_units', 'YES'],
      ['transactions', 'approved_by_user_id', 'YES'],
      ['commitments', 'vendor_id', 'YES'],
      ['audit_events', 'before_state_json', 'YES'],
      ['audit_events', 'after_state_json', 'NO'],
    ])('%s.%s is_nullable=%s', async (table, column, expected) => {
      const columns = await getColumns(migrated.db, table)
      expect(findColumn(columns, column).is_nullable).toBe(expected)
    })
  })

  it('has foreign keys for the core financial/ledger relationships', async () => {
    const result = await migrated.db.query<{
      table_name: string
      column_name: string
      foreign_table_name: string
    }>(
      `select
         tc.table_name,
         kcu.column_name,
         ccu.table_name as foreign_table_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       join information_schema.constraint_column_usage ccu
         on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
       where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`,
    )

    const fks = new Set(
      result.rows.map(
        (r: {
          table_name: string
          column_name: string
          foreign_table_name: string
        }) => `${r.table_name}.${r.column_name}->${r.foreign_table_name}`,
      ),
    )

    const expectedForeignKeys = [
      'user_roles.user_id->users',
      'projects.cloned_from_project_id->projects',
      'commitments.project_id->projects',
      'commitments.vendor_id->vendors',
      'transactions.source_project_id->projects',
      'transactions.destination_project_id->projects',
      'transactions.commitment_id->commitments',
      'transactions.custody_advance_transaction_id->transactions',
      'transactions.reverses_transaction_id->transactions',
      'transactions.donor_user_id->users',
      'transactions.cash_handler_user_id->users',
      'transactions.created_by_user_id->users',
      'attachment_metadata.transaction_id->transactions',
      'audit_events.actor_user_id->users',
      'pooja_days.pooja_config_id->pooja_configs',
      'pooja_slots.pooja_day_id->pooja_days',
      'pooja_participants.pooja_slot_id->pooja_slots',
      'inventory_movements.inventory_item_id->inventory_items',
    ]

    for (const expected of expectedForeignKeys) {
      expect(fks.has(expected), `missing FK: ${expected}`).toBe(true)
    }
  })

  it('has the required uniqueness constraints', async () => {
    const constraintResult = await migrated.db.query<{
      table_name: string
      constraint_name: string
    }>(
      `select table_name, constraint_name
         from information_schema.table_constraints
        where constraint_type = 'UNIQUE' and table_schema = 'public'`,
    )
    const uniqueConstraintTables = constraintResult.rows.map(
      (r: { table_name: string; constraint_name: string }) => r.table_name,
    )

    expect(uniqueConstraintTables).toContain('users') // username
    expect(uniqueConstraintTables).toContain('transactions') // idempotency_key
    expect(uniqueConstraintTables).toContain('budgets') // (project_id, category_id)
    expect(uniqueConstraintTables).toContain('pooja_configs') // project_id
    expect(uniqueConstraintTables).toContain('pooja_days') // (pooja_config_id, day_number)
    expect(uniqueConstraintTables).toContain('pooja_slots') // (pooja_day_id, slot_type)

    // The General Reserve "at most one" rule is a partial UNIQUE INDEX,
    // not a table constraint -- verified separately via pg_indexes.
    const indexResult = await migrated.db.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'public' and indexname = 'uidx_projects_single_general_reserve'`,
    )
    expect(indexResult.rows.length).toBe(1)
  })

  it('has the required transaction routing CHECK constraints', async () => {
    const result = await migrated.db.query<{ constraint_name: string }>(
      `select con.conname as constraint_name
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
        where rel.relname = 'transactions' and con.contype = 'c'`,
    )
    const names = new Set(
      result.rows.map((r: { constraint_name: string }) => r.constraint_name),
    )

    const expectedCheckConstraints = [
      'chk_tx_maker_checker',
      'chk_tx_donation_routing',
      'chk_tx_donation_member_donor',
      'chk_tx_donation_public_no_donor',
      'chk_tx_expense_routing',
      'chk_tx_expense_advance_shape',
      'chk_tx_expense_settlement_shape',
      'chk_tx_temple_village_donation_out_shape',
      'chk_tx_internal_fund_transfer_shape',
      'chk_tx_reversal_requires_original',
      'chk_tx_only_reversal_has_original',
      'chk_tx_custody_link_whitelist',
      'chk_tx_internal_cash_disbursement_shape',
      'chk_tx_internal_cash_return_shape',
      'chk_tx_void_requires_reason',
    ]

    for (const expected of expectedCheckConstraints) {
      expect(names.has(expected), `missing CHECK: ${expected}`).toBe(true)
    }
  })

  it('has RLS enabled on every table, with real policies defined from Phase 2D onward', async () => {
    const result = await migrated.db.query<{
      relname: string
      relrowsecurity: boolean
    }>(
      `select c.relname, c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    )

    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(
        true,
      )
    }
    expect(result.rows.length).toBe(EXPECTED_TABLES.length)

    const policyResult = await migrated.db.query<{ count: string }>(
      `select count(*)::text as count from pg_policies where schemaname = 'public'`,
    )
    // As of Phase 2D, real RLS policies exist (migration 0019) --
    // this just confirms policies are actually present, not their
    // exact count or content (that is exhaustively covered by
    // supabase/tests/rpc/rls-authorization.test.ts).
    expect(Number(policyResult.rows[0]?.count)).toBeGreaterThan(0)
  })
})
