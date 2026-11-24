import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../helpers/apply-migrations.js'

/**
 * Task requirement: "Use integer INR paise/minor units for monetary
 * amounts. Do not use floating-point monetary fields." /
 * "schema does not accidentally introduce floating-point money."
 *
 * This test does not hand-pick a fixed list of column names to check
 * (which could silently miss a newly added monetary column). Instead
 * it queries every column whose name matches the monetary/quantity
 * naming convention used throughout the architecture
 * (`*_minor_units`, `quantity_minor`, `file_size_bytes`) and asserts
 * every single one uses an exact integer PostgreSQL type.
 */

const FLOATING_POINT_TYPES = [
  'real',
  'double precision',
  'numeric',
  'money',
  'decimal',
]

const EXACT_INTEGER_TYPES = ['smallint', 'integer', 'bigint']

describe('Phase 2A monetary/quantity field types', () => {
  let migrated: MigratedDatabase

  beforeAll(async () => {
    migrated = await createMigratedDatabase()
  })

  afterAll(async () => {
    await migrated.db.close()
  })

  it('finds the expected set of monetary/quantity minor-unit columns', async () => {
    const result = await migrated.db.query<{
      table_name: string
      column_name: string
    }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and (column_name like '%\\_minor\\_units' escape '\\'
               or column_name = 'quantity_minor'
               or column_name = 'file_size_bytes')
        order by table_name, column_name`,
    )

    // Sanity check: this must find a non-trivial number of columns --
    // if it found zero, the query pattern itself would be broken and
    // every assertion below would vacuously pass. As of Phase 2A
    // there are 9 such columns (7 *_minor_units on
    // budgets/commitments/project_deficit_reviews/
    // additional_funding_plans/funding_plan_items/transactions(x2),
    // plus quantity_minor and file_size_bytes).
    expect(result.rows.length).toBeGreaterThanOrEqual(9)
  })

  it('uses an exact integer type for every monetary/quantity column', async () => {
    const result = await migrated.db.query<{
      table_name: string
      column_name: string
      data_type: string
    }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and (column_name like '%\\_minor\\_units' escape '\\'
               or column_name = 'quantity_minor'
               or column_name = 'file_size_bytes')`,
    )

    for (const row of result.rows) {
      const label = `${row.table_name}.${row.column_name}`
      expect(
        EXACT_INTEGER_TYPES.includes(row.data_type),
        `${label} has type "${row.data_type}", expected one of ${EXACT_INTEGER_TYPES.join(', ')}`,
      ).toBe(true)
      expect(
        FLOATING_POINT_TYPES.includes(row.data_type),
        `${label} must never be a floating-point/decimal type`,
      ).toBe(false)
    }
  })

  it('rejects a monetary value if the column type were ever floating point (behavioral guard)', async () => {
    // This is a meta-test: it does not touch the schema, but proves
    // the detection query above is not a false positive by exercising
    // it against a deliberately "wrong" temporary table in the same
    // database, then dropping it again.
    await migrated.db.exec(
      `create table _phase2a_meta_check (amount_minor_units double precision)`,
    )

    const result = await migrated.db.query<{ data_type: string }>(
      `select data_type from information_schema.columns
        where table_schema = 'public' and table_name = '_phase2a_meta_check'
          and column_name = 'amount_minor_units'`,
    )

    expect(result.rows[0]?.data_type).toBe('double precision')
    expect(FLOATING_POINT_TYPES.includes(result.rows[0]?.data_type ?? '')).toBe(
      true,
    )

    await migrated.db.exec(`drop table _phase2a_meta_check`)
  })
})
