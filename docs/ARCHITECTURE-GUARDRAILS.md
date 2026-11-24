# Architecture guardrails

This document distills the non-negotiable rules from the canonical
architecture specification into a practical checklist for anyone (human
or AI) writing code in this repository. If something here seems to
conflict with a convenient shortcut, the shortcut is wrong -- these
rules exist specifically to prevent classes of financial-integrity bugs
(double counting, phantom money, client-forged state) that are cheap to
prevent up front and expensive to find later.

This is a **summary for engineering use**, not a replacement for the
architecture document itself. When in doubt, the architecture document
is authoritative.

## 1. PostgreSQL is the only financial authority

> "The PostgreSQL database is the authoritative financial state store."

Once the financial schema and RPC layer exist (not yet -- see
[§6](#6-what-phase-1-does-not-implement-and-why)):

- **Never** write a financial value (liquidity, income, expense,
  custody, commitment settlement, any derived balance) directly from
  the client. There must be no code path equivalent to
  `supabase.from('projects').update({ liquidity: 50000 })`.
- Every financial mutation goes through a server-side **Financial RPC**
  (`supabase.rpc('some_financial_function', ...)`), which runs the
  authoritative `FinancialEffectEngine` / `FinancialDomainEngine` logic
  inside an atomic PostgreSQL transaction.
- Client-side calculations (in React state, a hook, a utility function)
  may be shown to the user for responsiveness, but are **never**
  treated as the source of truth. If the server disagrees with a
  client-side estimate, the server wins, always.

## 2. RLS is access control, not financial validation

Row-Level Security answers _"is this user allowed to see/touch this
row?"_. It does not, and must not be asked to, answer _"is this
financial operation valid?"_. That second question is answered only by
the Financial RPC layer. Do not try to encode business rules like
"custody cannot go negative" as an RLS policy -- that belongs in the
RPC/domain engine.

**As of Phase 2D, this is no longer just a design principle -- it is
enforced.** RLS is enabled with real policies on all 20 tables
(`supabase/migrations/00000000000019_rls_policies.sql`):

- Supabase Auth is the authenticated identity source. `users.id`
  equals the Supabase Auth user id (`auth.uid()`) -- see the Phase 2A
  correction record below.
- Exactly four application roles exist: `MEMBER`, `ACCOUNTANT`,
  `ADMIN`, `AUDITOR` (§12.1). Role membership is resolved via
  `app_has_role()`/`app_has_any_role()`
  (`00000000000018_rbac_role_functions.sql`), which read `user_roles`
  keyed to `auth.uid()`.
- `transactions` and `audit_events` have **no** INSERT/UPDATE/DELETE
  grant to `authenticated` at all, at any role. Direct client
  financial writes are not authoritative and are not possible --
  financial mutation is exclusively through `financial_post_transaction()`
  (`SECURITY DEFINER`).
- `audit_events` actor attribution (`actor_user_id`) is always
  server/auth-derived (`auth.uid()`, resolved inside the RPC) -- a
  client cannot supply or influence it.
- Client-supplied user IDs cannot establish actor identity:
  `financial_post_transaction`'s `p_created_by_user_id` parameter is a
  consistency check only (it must equal `auth.uid()` if supplied) --
  it can never override the authenticated identity. See
  `00000000000020_financial_rpc_actor_identity.sql`.
- `SECURITY DEFINER` functions in this project
  (`financial_post_transaction`) are deliberately restricted: `search_path`
  is pinned, `EXECUTE` is revoked from `PUBLIC`/`anon` and granted only
  to `authenticated`, and the function performs its own role check
  (`ACCOUNTANT`/`ADMIN` only) before doing anything else.

## 3. Online-first, not offline-first

- Authoritative financial operations require a live connection to
  Supabase. There is no offline financial transaction engine, no
  background financial sync queue, and no conflict-merge system.
- `IndexedDB` (or any other client-side storage) may hold **drafts,
  caches, and temporary UI state only**. A locally saved draft must
  always be visibly distinguishable from a submitted/`POSTED`
  transaction (e.g. labeled "Not yet recorded") and must never be
  counted in any balance, total, or report.
- The PWA's service worker (`vite-plugin-pwa`, configured in
  `vite.config.ts`) exists purely to make the static app shell
  installable and fast to load. Its precache list is deliberately
  restricted to static assets (HTML/CSS/JS/icons/manifest) and its
  navigation fallback explicitly denylists `/api`, `/rest`, `/auth`,
  and `/storage` paths. **Do not add runtime caching (`runtimeCaching`
  workbox config) for any Supabase endpoint.** If you need offline
  _reads_ of non-financial reference data later, that is a deliberate
  product decision to be made explicitly, not a side effect of a
  workbox config change.

## 4. Idempotency, not synchronization

When the financial RPC layer is introduced, mutation requests will
carry an idempotency key so that a network retry or duplicate
submission can never create a second financial transaction. This is
**request/submission idempotency** -- a stateless, online-only
mechanism. It is not, and must not become, an offline sync queue,
last-write-wins merge system, or any kind of local authoritative
transaction log.

## 5. No accounting-system scope creep

This is a committee accountability tool, not general-purpose accounting
software. Do not introduce, even as a "helpful" abstraction:

- Double-entry bookkeeping, a general ledger, or debit/credit modeling
- GST/tax accounting or bank reconciliation
- A payment gateway integration
- AI/OCR-based data extraction
- A custom permission-builder or additional user roles beyond the four
  fixed roles (`MEMBER`, `ACCOUNTANT`, `ADMIN`, `AUDITOR`)

## 6. What has been built so far, and what still is not implemented

**Phase 1** (React + TypeScript + Vite, installable PWA shell, Supabase
**client** foundation with no auth flows wired up, lint/format/test
tooling, design tokens) is complete.

**Phase 2A** added the PostgreSQL **database schema** for all 20
architecture entities (`supabase/migrations/`) -- tables, columns,
foreign keys, uniqueness constraints, the transaction-routing CHECK
constraints, the General Reserve structural guardrails (at most one
General Reserve, it cannot be cloned/closed), physical-delete-ban and
append-only-audit-trail triggers, and RLS **enabled with zero
policies** (default-deny; not an authorization implementation).

**Phase 2B** added the authoritative **`FinancialEffectEngine` /
PostgreSQL RPC layer** on top of that schema:

- `financial_evaluate_transaction()` -- the pure 7-effect vector
  evaluator (§7), including the custody-linked
  `EXPENSE_DIRECT`/`EXPENSE_ADVANCE`/`EXPENSE_SETTLEMENT` variants and
  `REVERSAL`'s mathematical negation of the original.
- The `financial_effects` view and derived-value functions
  (`financial_project_liquidity`, `financial_recognized_income`,
  `financial_recognized_expense`, `financial_net_performance`,
  `financial_commitment_outstanding`, `financial_custody_balance`,
  `financial_liquidity_shortage`) implementing §8's equations.
- `financial_post_transaction()` -- the single controlled Financial
  RPC. All financial mutations (donations, auction receipts, vendor
  advances/settlements, internal transfers, custody
  disbursement/spend/return, and reversals) go through this one
  function, which validates commitment direction/bounds, custody
  type/bounds, project-liquidity bounds, General Reserve participation
  restrictions, closed-project rejection, and maker-checker, then
  atomically posts the transaction and its audit event.

See `supabase/migrations/00000000000016_financial_effect_engine.sql`
and `00000000000017_financial_post_transaction.sql` for the full
implementation and inline citations back to the architecture.

**Phase 2D** added the **Supabase Auth + RBAC + RLS authorization
boundary**:

- `app_current_user_id()`, `app_has_role()`, `app_has_any_role()`
  (`00000000000018_rbac_role_functions.sql`) -- the single place every
  RLS policy and the financial RPC answer "who is this, and what
  role(s) do they hold."
- Real RLS policies on all 20 tables
  (`00000000000019_rls_policies.sql`), replacing Phase 2A's
  default-deny-with-zero-policies placeholder. See §2 above for the
  summary and the migration file itself for the table-by-table design
  (including several explicitly disclosed simplifications, e.g.
  `project_deficit_reviews` UPDATE being ADMIN-only in full rather
  than column-split between "create" and "approve").
- `financial_post_transaction` corrected to resolve `auth.uid()` as
  the sole authoritative actor identity, with `p_created_by_user_id`
  demoted to a consistency check
  (`00000000000020_financial_rpc_actor_identity.sql`). The RPC also
  now enforces its own minimal role gate (ACCOUNTANT/ADMIN required to
  post) before doing anything else.
- A **security hardening fix** applied to `financial_evaluate_transaction()`
  and every derived-value function from Phase 2B: all now pin
  `set search_path = public`, closing a search_path vulnerability the
  Phase 2D security review found (see `00000000000016_financial_effect_engine.sql`'s
  updated header comment).
- A **local test-only** auth/RLS simulation harness
  (`supabase/tests/helpers/apply-migrations.ts`) that recreates
  Supabase's real `auth.uid()`/`auth.role()`/role mechanism -- **never
  shipped as a real migration** (a real Supabase project already
  provides all of this; creating it ourselves would be actively
  dangerous against a real project). See that file's header comment
  for the exact, disclosed boundary of what this does and does not
  faithfully reproduce (JWT issuance/validation is out of scope; RLS
  and `auth.uid()` enforcement themselves are genuinely exercised).

Do **not** add any of the following until their explicitly scoped
phase, even though the schema/RPC/RLS layer they'd build on already
exists:

- The full RBAC/maker-checker **approval workflow** (submit → pending
  → approve/reject as separate steps). `financial_post_transaction`
  posts directly as `POSTED` and accepts an optional approver tagged
  atomically at post time; there is no draft/pending state machine yet.
- Project closure or project cloning **execution** (their structural
  guardrails exist in the schema and RLS now blocks `status = 'CLOSED'`
  and General-Reserve-as-clone-source at the row level, but the RPCs
  that perform closure/cloning themselves do not exist yet)
- A user/account **provisioning RPC** -- ADMIN currently gets direct
  RLS-gated INSERT/UPDATE on `users`/`user_roles`; a dedicated,
  more auditable provisioning workflow is future work.
- Offline financial synchronization of any kind
- Pooja, Annadanam, or inventory business logic and reports
- Full application dashboards, notifications, or reporting
- The complete authentication UI (login/logout/password reset/
  invitation flows) -- only the authorization _boundary_ was in scope
  for Phase 2D, not UI completion.

If a task description asks you to build one of these before its phase
has been reached, stop and flag the conflict rather than proceeding --
this list is intentionally exhaustive of what's _out_ of scope right
now, not just illustrative.

## 7. Where these rules come from

Every rule above is a direct restatement of a specific part of the
canonical architecture document (technology stack, online-first
mutation contract, financial engine sections, and RBAC/security
sections). If a future architecture revision changes one of these
rules, update this document in the same change -- it must never drift
from the source of truth it summarizes.

## 8. Flagged discrepancy: the "7 effects" (Phase 2B)

The Phase 2B task prompt's own "CRITICAL FINANCIAL MODEL" section
listed 7 effects as: Cash Movement, Recognized Income, Recognized
Expense, Commitment Change, Source Liquidity, Cash Custody, and
"Project Closure". **This does not match the architecture.** The
architecture (§7) defines the 7 effects as: (1) Cash Movement,
(2) Destination Liquidity, (3) Source Liquidity, (4) Recognized
Income, (5) Recognized Expense, (6) Cash Custody, (7) Commitment
Settlement. "Project Closure" is not one of the 7 effects anywhere in
the architecture -- §17.6 explicitly states closure creates NO
financial effect of any kind, and the same Phase 2B prompt separately
instructed "Do NOT implement project closure in this phase."

Per the standing instruction that the architecture document is the
sole authoritative source, and per the explicit instruction to report
rather than invent when a contradiction is found, `financial_evaluate_transaction()`
implements the architecture's actual 7 effects (including the
"Destination Liquidity" effect the prompt's list omitted), not the
prompt's paraphrased list. If a future task reintroduces this
"Project Closure effect" framing, treat it as the same already-flagged
discrepancy rather than a new instruction to comply with silently.

## 9. Invariant Coverage Tracking (as of end of Phase 2B)

Per §14's requirement that every invariant have an identifiable
`INVARIANT-01`…`INVARIANT-65` test, and the explicit instruction not to
falsely claim completeness: this is the honest, current state. "Tested"
below means a `supabase/tests/rpc/*.test.ts` assertion genuinely
exercises the invariant against the live `financial_post_transaction`
RPC (schema-level existence checks from Phase 2A are not double-counted
here).

**Tested (34 of 65):** 1–22, 33 (partially, via the liquidity
drilldown test), 36, 38, 39, 42, 44, 46, 47, 48, 49, 51, 52, 53, 54,
56, 57, 58, 59, 60, 61, 62, 63, 64, 65.

**Not yet tested (execution/UI/later-phase concepts with no RPC yet):**

- 23–25, 32 (surplus return execution — no surplus/closure RPC yet)
- 26–31 (deficit/funding workflow execution — tables exist from Phase
  2A, no RPC yet)
- 34 (full reconciliation lifecycle — depends on closure execution)
- 35, 40, 41 (reversal-history / physical-delete / attachment-purge —
  already covered by Phase 2A schema-trigger tests, not re-tested at
  the RPC layer since the RPC doesn't add new behavior here)
- 43 (client/local-state-cannot-overwrite-truth — this is a client-side
  architectural property; nothing to test at the database layer alone)
- 45, 50, 55 (report reconciliation, zero-unexplained-liquidity-at-
  creation, funding-plan-realization — depend on reporting/funding
  execution not yet built)

**Note on 33 (Liquidity Traceability):** the drilldown test proves
`financial_project_liquidity()` exactly equals a raw sum over
`financial_effects`, but does not yet include a test drilling into
every custody/commitment-linked transaction type in one combined
scenario -- treat this invariant as partially, not fully, covered.

This table must be updated by whichever phase adds the missing
coverage -- do not let it silently go stale.

## 10. Correction record: custody/reversal consistency bug

**Symptom:** reversing an `INTERNAL_CASH_DISBURSEMENT` correctly
restored project liquidity but left `financial_custody_balance()`
stuck at the original disbursed amount (phantom custody).

**Root cause:** a `REVERSAL` inherits `custody_advance_transaction_id`
from its original (§10.2). A disbursement's own
`custody_advance_transaction_id` is always `NULL` (it creates a
custody advance, it does not reference one), so its reversal also had
`custody_advance_transaction_id = NULL` -- making that reversal's `-A`
custody effect invisible to `financial_custody_balance()`'s aggregate,
which only looked at the disbursement's own row and rows referencing
it via `custody_advance_transaction_id`.

**A second, previously-undiscovered bug surfaced while testing the
fix:** reversing _any_ custody-linked transaction
(`EXPENSE_DIRECT`/`EXPENSE_ADVANCE`/`EXPENSE_SETTLEMENT`/`INTERNAL_CASH_RETURN`)
was structurally impossible -- the `chk_tx_custody_link_whitelist`
CHECK constraint on `transactions` never included `'REVERSAL'` in its
allowed-type list, so the inherited `custody_advance_transaction_id`
on any such reversal violated the constraint outright before
`financial_custody_balance()` was ever reached.

**Fix (both in migrations that had never been deployed, edited in
place per this project's established migration-discipline precedent):**

1. `00000000000007_transactions.sql`: added `'REVERSAL'` to
   `chk_tx_custody_link_whitelist`'s allowed type list.
2. `00000000000016_financial_effect_engine.sql`: exposed
   `reverses_transaction_id` as a trailing column on the
   `financial_effects` view, and added a third summed term to
   `financial_custody_balance()` for POSTED transactions whose
   `reverses_transaction_id` equals the disbursement -- this cannot
   double-count, because a reversal of the disbursement itself always
   has `custody_advance_transaction_id = NULL` (never the
   disbursement's own id), so it can never also match the second term.

See `supabase/tests/rpc/custody-reversal-consistency.test.ts` (9
tests) for the full verification, including money-conservation and a
multi-step disbursement → spend → partial-return → reversal sequence.

## 11. Phase 2D security review

Conducted against every new RLS policy and the corrected financial
RPC, per the specific checklist the Phase 2D task required:

| Check                             | Finding                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Privilege escalation              | None found. `user_roles` INSERT/UPDATE/DELETE is ADMIN-only; no policy lets a role grant itself broader access.                                                                                                                                                                                                                                                                                                                      |
| Self-role elevation               | Blocked -- a non-ADMIN has zero mutation grant on `user_roles`, including for their own row. Tested (`rls-authorization.test.ts` #8).                                                                                                                                                                                                                                                                                                |
| User impersonation                | Fixed. `financial_post_transaction` now resolves `auth.uid()` as authoritative; a mismatched `p_created_by_user_id` is rejected outright. Tested (#10, #12).                                                                                                                                                                                                                                                                         |
| Unrestricted authenticated access | Audited every policy for bare `USING (true)`/`WITH CHECK (true)`. Found only on intentionally-broad SELECT policies (financial/operational transparency, §12.1) and on `pooja_participants` INSERT/UPDATE (explicitly disclosed exception -- ordinary member sign-up, not a sensitive operation). No sensitive-table mutation policy is unconditional. Verified structurally (test in `rls-authorization.test.ts`).                  |
| Direct financial writes           | Blocked. `transactions`/`audit_events` have no INSERT/UPDATE/DELETE grant to `authenticated` at all, at any role. Tested (#15-#18).                                                                                                                                                                                                                                                                                                  |
| `SECURITY DEFINER` misuse         | `financial_post_transaction` is the only `SECURITY DEFINER` function in the project. Justified: it must write to `transactions`/`audit_events`, which `authenticated` has no direct grant on by design. Restricted: `search_path` pinned; `EXECUTE` revoked from `PUBLIC`/`anon`, granted only to `authenticated`; the function performs its own role check before any mutation. No generic/unrestricted privileged function exists. |
| `search_path` vulnerabilities     | **Found and fixed**: `financial_evaluate_transaction()` and all 8 derived-value functions (Phase 2B) lacked `set search_path = public`. Retroactively added in this pass (migration 0016 had never been deployed) -- see the correction note at the top of that migration file.                                                                                                                                                      |
| Caller-controlled actor identity  | Fixed -- see "User impersonation" above.                                                                                                                                                                                                                                                                                                                                                                                             |
| Audit spoofing                    | Blocked. No INSERT grant on `audit_events` to `authenticated`; `actor_user_id` is always `v_actor_id` (`auth.uid()`), never a parameter. Tested (#19).                                                                                                                                                                                                                                                                               |

**One additional gap found and fixed, not on the checklist but directly
relevant to it:** `financial_post_transaction` (Phase 2B) had never
explicitly revoked its default `PUBLIC` `EXECUTE` grant -- PostgreSQL
grants `EXECUTE` on new functions to `PUBLIC` unless revoked. This
meant, prior to this fix, even an unauthenticated (`anon`) caller could
have attempted to call the RPC (and would have been rejected by the
new `auth.uid()`/role checks regardless -- but relying on that alone,
rather than also closing the grant, is weaker defense in depth).
Migration 0020 now explicitly revokes `EXECUTE` from `PUBLIC` and
`anon` and grants it only to `authenticated`.
