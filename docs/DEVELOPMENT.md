# Development guide

This document covers day-to-day development for CommitteeApp. For the
non-negotiable architectural rules (what you must never do, regardless of
convenience), see [`ARCHITECTURE-GUARDRAILS.md`](ARCHITECTURE-GUARDRAILS.md)
instead -- read that one first if you are about to start a new phase of
work.

## Prerequisites

- Node.js 20+ and npm
- A Supabase project (optional for Phase 1 -- the app runs, builds and
  tests correctly without one; you only need it once later phases start
  calling Supabase Auth or the financial RPC layer)

## First-time setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local` with your own Supabase project's public URL and
anonymous key. `.env.local` is git-ignored and must never be committed.
These two values are the Supabase **public** URL and **anon** key --
safe to ship to the browser by design; do not put a service-role key or
any other secret in a `VITE_`-prefixed variable, since anything with
that prefix is bundled into the client and is publicly readable.

If you skip this step, the app still runs: `src/shared/config/env.ts`
logs a console warning (outside test mode) and
`env.isSupabaseConfigured` reports `false`. The app shell reflects this
in its status list. Nothing crashes.

## Running the app

```bash
npm run dev
```

Opens the Vite dev server (default `http://localhost:5173`). Hot module
reload is enabled.

## Verifying your work

Before committing, run the same checks CI expects:

```bash
npm run typecheck     # tsc -b, strict mode (covers src/, supabase/, and configs)
npm run lint           # ESLint (flat config)
npm run format:check   # Prettier, no writes
npm run test:all        # App test suite + database/schema test suite
npm run build           # production build, including PWA output
```

`npm test` alone runs only the app (React/UI) suite; `npm run test:db`
runs only the database/schema suite. `npm run test:all` runs both, and
is what you should run before committing anything that touches
`supabase/`.

`npm run lint:fix` and `npm run format` will auto-fix what they can.

### PWA build verification

`npm run build` produces `dist/`, including `manifest.webmanifest`,
`sw.js` (the generated service worker), and `registerSW.js`. To sanity
check the PWA output locally:

```bash
npm run build
npm run preview
```

Then open the preview URL in a Chromium-based browser and check
DevTools → Application → Manifest / Service Workers. The manifest must
have `name`, `short_name`, `start_url`, `display: standalone`, and at
least a 192×192 and a 512×512 icon for the browser to consider the app
installable.

**Guardrail check while doing this:** open DevTools → Application →
Service Workers → and inspect the precache list (or grep `dist/sw.js`
for `precacheAndRoute`). It must only ever contain static app-shell
files (HTML/CSS/JS/icons/manifest) -- never an API, auth, or storage
route. `vite.config.ts` already denylists `/api|rest|auth|storage/` in
the navigation fallback and only globs static asset extensions into the
precache; if you change that configuration, re-verify this by hand.

## Database (Phase 2A+)

> **The financial RPC layer, `FinancialEffectEngine`, and RLS
> authorization policies are NOT implemented yet.** Phase 2A is
> PostgreSQL schema/structure only -- see
> [`ARCHITECTURE-GUARDRAILS.md`](ARCHITECTURE-GUARDRAILS.md) §6 for the
> full list of what is intentionally still missing.

### Migration location

`supabase/migrations/*.sql`, applied in filename order (they are
numbered `00000000000001_...` through `00000000000015_...`). Each file
is grouped by concern (e.g. `..._transactions.sql`,
`..._general_reserve_guardrails.sql`) and its top-of-file comment cites
the exact architecture section it implements. Do not renumber or
reorder existing files; add new ones with the next sequential number.

### Applying migrations locally

This repository does not assume the Supabase CLI or Docker are
installed -- neither is required to develop against or test the
schema. Two supported ways to apply the migrations:

**Option A -- Supabase CLI + a real Supabase project (recommended once
you have one):**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

This applies `supabase/migrations/*.sql`, in order, to your linked
Supabase project. The `supabase/migrations/` directory already follows
the Supabase CLI's expected layout, so no restructuring is needed.

**Option B -- any PostgreSQL instance (local Postgres, Supabase CLI's
local stack via `supabase start`, or similar):**

Concatenate and run the files in order with `psql`, e.g.:

```bash
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done
```

### Database/schema testing

```bash
npm run test:db
```

This runs `supabase/tests/**/*.test.ts` under a **separate** Vitest
config (`vitest.config.db.ts`, plain Node environment -- not jsdom).
Each suite applies every migration to a **fresh, real PostgreSQL
instance** via [PGlite](https://pglite.dev/) (a WebAssembly build of
actual PostgreSQL) and then runs genuine SQL assertions against it --
table/column/type existence, foreign keys, unique/check constraints,
the General Reserve structural guardrails, the physical-delete/
append-only immutability triggers, and (from Phase 2B on) the
`financial_post_transaction` RPC itself. Nothing is mocked or faked.

**Known scope limit:** PGlite is vanilla PostgreSQL. It has no `auth`
schema, no PostgREST, and no Supabase-managed roles
(`anon`/`authenticated`/`service_role`). It verifies the migrations are
valid, structurally self-consistent PostgreSQL; it does **not** verify
Supabase-specific integration (e.g. RLS as actually enforced through
PostgREST, or Supabase Auth's `auth.users` table). Re-verify that layer
against a real Supabase project (Option A above) once one is
available -- this is a real, disclosed blocker, not an oversight.

**Additional Phase 2B limit:** PGlite runs as a single WASM process
and internally serializes all query execution -- it does not offer
multiple genuinely concurrent connections. `supabase/tests/rpc/concurrency-and-authorization.test.ts`
therefore cannot exercise a true multi-connection race condition (two
sessions blocking on the same row lock); it verifies the boundary-check
logic is correct under a rapid sequence of calls, and that the RPC's
deployed SQL actually contains the required `SELECT ... FOR UPDATE`
locking, but true lock-contention timing must be verified against a
real multi-connection Postgres/Supabase environment. See that test
file's header comment for the full disclosure.

### Financial RPC layer (Phase 2B)

The authoritative financial mutation engine lives in
`supabase/migrations/00000000000016_financial_effect_engine.sql`
(the pure `financial_evaluate_transaction()` evaluator, the
`financial_effects` aggregation view, and the derived-value functions
implementing §8's equations) and
`00000000000017_financial_post_transaction.sql` (the single controlled
Financial RPC, `financial_post_transaction()`).

**Client code must call this RPC, never write to `transactions`/
`audit_events` directly.** Example call shape (named-argument syntax):

```sql
select * from financial_post_transaction(
  p_idempotency_key => 'unique-client-generated-key',
  p_transaction_type => 'DONATION_MEMBER',
  p_created_by_user_id => '<uuid>',
  p_destination_project_id => '<uuid>',
  p_amount_minor_units => 500000, -- ₹5,000 in paise
  p_donor_user_id => '<uuid>'
);
```

See `supabase/tests/rpc/helpers.ts`'s `postTransaction()` for the
equivalent from a Node/test client, and
`docs/ARCHITECTURE-GUARDRAILS.md` §6 for exactly what this RPC does and
does not do yet.

### Authorization boundary (Phase 2D)

**Supabase Auth is the authenticated identity source.** `users.id`
equals the Supabase Auth user id -- there is no separate application
identity. Exactly four roles exist (`MEMBER`, `ACCOUNTANT`, `ADMIN`,
`AUDITOR`, §12.1); role membership lives in `user_roles` and is
resolved via `app_has_role()`/`app_has_any_role()`
(`00000000000018_rbac_role_functions.sql`).

**RLS enforces database access; the financial RPC enforces financial
business rules** -- these remain two separate concerns (see
`docs/ARCHITECTURE-GUARDRAILS.md` §2). `financial_post_transaction`
now resolves `auth.uid()` as the sole authoritative actor identity --
a client can no longer attribute a transaction to another user by
passing a different `p_created_by_user_id`; that parameter, if
supplied, must match the authenticated caller or the call is rejected.

To call the RPC (or run any RLS-gated query) from a Node test client,
the calling session must be authenticated first:

```ts
import {
  setAuthContext,
  clearAuthContext,
} from '../helpers/apply-migrations.js'

await setAuthContext(db, someUserId) // switches to `authenticated`, sets auth.uid()
// ... run RLS-gated queries or call financial_post_transaction ...
await clearAuthContext(db) // back to the neutral/superuser test context
```

`postTransaction()`/`postTransactionAs()` in `supabase/tests/rpc/helpers.ts`
already wrap this for you -- see that file's doc comments. `createUser()`
now defaults to assigning the `ACCOUNTANT` role (the minimum needed to
post financial transactions) so pre-Phase-2D tests kept working
unchanged; pass `roles: [...]` explicitly to test a different role
boundary.

**Local test-only auth/RLS simulation:** since PGlite has no real
Supabase `auth` schema, `supabase/tests/helpers/apply-migrations.ts`
recreates the _externally observable behavior_ of Supabase's
pre-provisioned `anon`/`authenticated`/`service_role` roles and
`auth.uid()`/`auth.role()` functions before applying our own
migrations -- exactly matching Supabase's own documented
implementation. **This is never shipped as a real migration** -- a
real Supabase project already has all of this; our migrations only
reference it (via `GRANT ... TO authenticated`, RLS policies calling
`auth.uid()`, etc.). See that file's header comment for the precise,
disclosed boundary of what is and is not faithfully reproduced (RLS
and `auth.uid()` enforcement themselves are genuine; JWT
issuance/validation via GoTrue/PostgREST is out of scope and untested
here).

### Writing a new migration

- One concern per file; keep files small enough to review in one pass.
- Every table/constraint/RPC validation should be traceable to a
  specific line or section of the architecture document in a comment
  -- don't add a constraint "because it seems sensible."
- Prefer `ON DELETE RESTRICT`/`ON DELETE NO ACTION` for financial
  entities; `ON DELETE CASCADE` is reserved for non-financial
  structural sub-entities (e.g. `pooja_days` → `pooja_slots`), per
  §6.1 of the architecture.
- Add a matching test in `supabase/tests/schema/` (structural) or
  `supabase/tests/rpc/` (behavioral) in the same change.

## Testing conventions

- Test framework: Vitest, with `@testing-library/react` for component
  tests and `@testing-library/jest-dom` matchers.
- `vite.config.ts` sets `test.globals: false` -- import `describe`,
  `it`, `expect`, etc. explicitly from `vitest` rather than relying on
  globals. This keeps test files type-checked the same way as the rest
  of the app.
- Co-locate tests next to the code they cover (`Foo.tsx` +
  `Foo.test.tsx`), matching the existing `src/app/App.test.tsx` and
  `src/shared/**/*.test.ts` examples.
- `src/shared/testing/setup-tests.ts` runs before every test file: it
  registers jest-dom matchers and cleans up the DOM after each test.
  You should not need to touch it for ordinary feature work.

## Code style

- TypeScript strict mode is on (`tsconfig.app.json` /
  `tsconfig.node.json`) -- this includes `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `noImplicitOverride` on top of the
  standard `strict` flag set. Don't loosen these without a strong,
  explicit reason.
- ESLint's flat config (`eslint.config.js`) runs
  `typescript-eslint`'s type-checked recommended + stylistic rule sets,
  `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks`, and
  `eslint-plugin-react-refresh`, with `eslint-config-prettier` last so
  formatting rules never fight Prettier.
- Prettier is the single source of truth for formatting
  (`.prettierrc.json`): no semicolons, single quotes, trailing commas,
  80-character print width.

## Adding a new module

Follow the existing `src/shared/<concern>/` pattern: one folder per
concern (`config`, `lib/supabase`, `styles`, `testing`, and so on),
each with its own tests next to the code. Do not introduce a global
`utils` dumping-ground folder.

## What NOT to build yet

This is a summary -- the authoritative list lives in
[`ARCHITECTURE-GUARDRAILS.md`](ARCHITECTURE-GUARDRAILS.md). As of Phase
2A, the database _schema_ exists (`supabase/migrations/`), but do not
add: financial RPCs/functions, the `FinancialEffectEngine`/7-effect
vector implementation, expense recognition, payment posting, custody
movement logic, transfer execution, reversals, financial authorization
workflows, maker-checker _execution_, project closure _execution_,
project cloning _execution_, deficit/funding _execution_, or RLS
authorization policies (RLS is enabled with zero policies -- see
`supabase/migrations/00000000000014_row_level_security_default_deny.sql`).
Pooja/Annadanam/inventory business logic and reports also remain out
of scope. Those all belong to later, explicitly scoped phases.
