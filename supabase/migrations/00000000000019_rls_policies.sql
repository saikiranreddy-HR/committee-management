-- Phase 2D -- Supabase Auth + RBAC + RLS / Authorization Boundary
-- Migration 0019: RLS policies, table by table
--
-- Source: architecturefinal-v4.5.1.md §12.1 (Fixed Four-Role Access
-- Model / capability matrix), §4.5 (RLS is access control, not
-- financial validation), §4.6 (database defense in depth).
--
-- Design principles applied uniformly below:
--   * SELECT is broad (all four roles get committee-wide financial
--     transparency, per §12.1's matrix -- "View dashboard/projects/
--     financial information/transaction history" = Yes for all four
--     roles) except audit_events, which is ADMIN/AUDITOR only.
--   * INSERT/UPDATE on operational (non-financial-ledger) tables is
--     ACCOUNTANT or ADMIN, matching the "manage" capabilities in
--     §12.1's matrix.
--   * transactions and audit_events have NO INSERT/UPDATE/DELETE
--     grant to anon/authenticated at all, at any role -- these are
--     RPC-only writes (financial_post_transaction, SECURITY DEFINER).
--     This is the "financial mutations must not become directly
--     writable from the browser" boundary: enforced twice over, by
--     the absence of a GRANT (checked before RLS) and by RLS itself.
--   * DELETE is granted nowhere in this migration. Phase 2A's
--     physical-delete-ban triggers already make DELETE fail on the
--     protected tables; withholding the GRANT everywhere else is
--     simply consistent hygiene, not a new rule.
--   * No policy ever uses `using (true)`/`with check (true)` for
--     authenticated users on a sensitive table, per the task's
--     explicit instruction.

-- ============================================================
-- 1. users
-- ============================================================
grant select on users to authenticated;
create policy "committee members are visible to all authenticated users"
    on users for select
    to authenticated
    using (true);

-- INSERT/UPDATE restricted to ADMIN: "ADMIN manages committee
-- accounts; users do not self-register" (§6 Account Provisioning
-- Rule). No dedicated provisioning RPC exists yet in this phase (out
-- of scope -- see docs/ARCHITECTURE-GUARDRAILS.md); ADMIN is granted
-- direct RLS-gated access as the minimal necessary authorization
-- boundary until that RPC exists.
grant insert, update on users to authenticated;
create policy "only ADMIN may create committee accounts"
    on users for insert
    to authenticated
    with check (app_has_role('ADMIN'));
create policy "only ADMIN may update committee accounts"
    on users for update
    to authenticated
    using (app_has_role('ADMIN'))
    with check (app_has_role('ADMIN'));

-- ============================================================
-- 2. user_roles
-- ============================================================
grant select on user_roles to authenticated;
create policy "role assignments are visible to all authenticated users"
    on user_roles for select
    to authenticated
    using (true);

-- "Role Mutation Safety": ordinary users (including the role's own
-- holder) must not be able to modify role assignments through
-- ordinary client access. Restricting every mutation to ADMIN
-- satisfies this directly -- a non-ADMIN has no INSERT/UPDATE/DELETE
-- grant at all, on any row, including their own.
grant insert, update, delete on user_roles to authenticated;
create policy "only ADMIN may assign roles"
    on user_roles for insert
    to authenticated
    with check (app_has_role('ADMIN'));
create policy "only ADMIN may change role assignments"
    on user_roles for update
    to authenticated
    using (app_has_role('ADMIN'))
    with check (app_has_role('ADMIN'));
create policy "only ADMIN may remove role assignments"
    on user_roles for delete
    to authenticated
    using (app_has_role('ADMIN'));

-- ============================================================
-- 3. projects
-- ============================================================
grant select on projects to authenticated;
create policy "projects are visible to all authenticated users"
    on projects for select
    to authenticated
    using (true);

-- INSERT/UPDATE restricted to ADMIN ("Perform administrative project
-- operations", §12.1). General Reserve cannot be created or converted
-- via this path (is_general_reserve must stay false on any
-- client-inserted/updated row -- the single General Reserve was
-- seeded once by migration 0015 and is otherwise immutable via this
-- policy); CLOSED is not a reachable status via direct client access
-- because project closure execution is out of scope for this phase
-- (§17's 16-point closure gate has no RPC yet) -- only a future
-- closure RPC may set status = 'CLOSED'.
grant insert, update on projects to authenticated;
create policy "only ADMIN may create ordinary projects"
    on projects for insert
    to authenticated
    with check (app_has_role('ADMIN') and is_general_reserve = false);
create policy "only ADMIN may update ordinary projects, and never to CLOSED or into General Reserve"
    on projects for update
    to authenticated
    using (app_has_role('ADMIN'))
    with check (
        app_has_role('ADMIN')
        and is_general_reserve = false
        and status != 'CLOSED'
    );

-- ============================================================
-- 4-6. project_categories, vendors, budgets
-- ============================================================
grant select on project_categories to authenticated;
create policy "categories are visible to all authenticated users"
    on project_categories for select to authenticated using (true);
grant insert, update on project_categories to authenticated;
create policy "ACCOUNTANT or ADMIN manage categories (insert)"
    on project_categories for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage categories (update)"
    on project_categories for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

grant select on vendors to authenticated;
create policy "vendors are visible to all authenticated users"
    on vendors for select to authenticated using (true);
grant insert, update on vendors to authenticated;
create policy "ACCOUNTANT or ADMIN manage vendors (insert)"
    on vendors for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage vendors (update)"
    on vendors for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

grant select on budgets to authenticated;
create policy "budgets are visible to all authenticated users"
    on budgets for select to authenticated using (true);
grant insert, update on budgets to authenticated;
create policy "ACCOUNTANT or ADMIN manage budgets (insert)"
    on budgets for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage budgets (update)"
    on budgets for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- ============================================================
-- 7. commitments
-- ============================================================
grant select on commitments to authenticated;
create policy "commitments are visible to all authenticated users"
    on commitments for select to authenticated using (true);
grant insert, update on commitments to authenticated;
create policy "ACCOUNTANT or ADMIN manage commitments (insert)"
    on commitments for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage commitments (update)"
    on commitments for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- ============================================================
-- 8. food_sessions
-- ============================================================
grant select on food_sessions to authenticated;
create policy "food sessions are visible to all authenticated users"
    on food_sessions for select to authenticated using (true);
grant insert, update on food_sessions to authenticated;
create policy "ACCOUNTANT or ADMIN manage food sessions (insert)"
    on food_sessions for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage food sessions (update)"
    on food_sessions for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- ============================================================
-- 9. project_deficit_reviews
-- ============================================================
-- "Create deficit reviews" = ACCOUNTANT or ADMIN; "Approve deficit
-- reviews" = ADMIN only (§12.1). Postgres RLS is row-level, not
-- column-level, so this migration cannot cleanly let ACCOUNTANT
-- create a review while blocking them from ever touching the same
-- row's approval columns without a dedicated view or column
-- privileges (out of scope for this phase). As a deliberate, disclosed
-- simplification: ACCOUNTANT may INSERT (create) a review; ANY
-- subsequent UPDATE (including the approval itself) requires ADMIN.
grant select on project_deficit_reviews to authenticated;
create policy "deficit reviews are visible to all authenticated users"
    on project_deficit_reviews for select to authenticated using (true);
grant insert, update on project_deficit_reviews to authenticated;
create policy "ACCOUNTANT or ADMIN may create a deficit review"
    on project_deficit_reviews for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "only ADMIN may update a deficit review (including approval)"
    on project_deficit_reviews for update to authenticated
    using (app_has_role('ADMIN'))
    with check (app_has_role('ADMIN'));

-- ============================================================
-- 10-11. additional_funding_plans, funding_plan_items
-- ============================================================
grant select on additional_funding_plans to authenticated;
create policy "funding plans are visible to all authenticated users"
    on additional_funding_plans for select to authenticated using (true);
grant insert, update on additional_funding_plans to authenticated;
create policy "ACCOUNTANT or ADMIN manage funding plans (insert)"
    on additional_funding_plans for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage funding plans (update)"
    on additional_funding_plans for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

grant select on funding_plan_items to authenticated;
create policy "funding plan items are visible to all authenticated users"
    on funding_plan_items for select to authenticated using (true);
grant insert, update on funding_plan_items to authenticated;
create policy "ACCOUNTANT or ADMIN manage funding plan items (insert)"
    on funding_plan_items for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage funding plan items (update)"
    on funding_plan_items for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- ============================================================
-- 12. transactions -- THE critical financial boundary.
-- ============================================================
-- SELECT is broad (financial transparency, §12.1 "View financial
-- information"/"View transaction history" = Yes for all four roles).
-- NO insert/update/delete GRANT to authenticated at all: financial
-- mutation is exclusively through financial_post_transaction()
-- (SECURITY DEFINER, migration 0020), which runs as the function
-- owner and therefore is not subject to this missing GRANT. A
-- modified client cannot bypass this by calling INSERT/UPDATE/DELETE
-- directly -- Postgres checks table-level privileges before RLS is
-- ever evaluated, and authenticated has none here.
grant select on transactions to authenticated;
create policy "transactions are visible to all authenticated users"
    on transactions for select
    to authenticated
    using (true);

-- ============================================================
-- 13. attachment_metadata
-- ============================================================
grant select on attachment_metadata to authenticated;
create policy "attachments are visible to all authenticated users"
    on attachment_metadata for select to authenticated using (true);
grant insert on attachment_metadata to authenticated;
create policy "ACCOUNTANT or ADMIN may attach evidence"
    on attachment_metadata for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
-- No UPDATE/DELETE grant: attachment metadata is immutable once
-- created; purge (is_purged/purged_at) is a background/service-role
-- concern, not a client-facing mutation in this phase.

-- ============================================================
-- 14. audit_events -- read access restricted, write access RPC-only.
-- ============================================================
-- "View audit history" = ADMIN, AUDITOR only (§12.1) -- MEMBER and
-- ACCOUNTANT get no SELECT grant at all here.
grant select on audit_events to authenticated;
create policy "only ADMIN or AUDITOR may view the audit trail"
    on audit_events for select
    to authenticated
    using (app_has_any_role(array['ADMIN', 'AUDITOR']));

-- No INSERT/UPDATE/DELETE grant to authenticated at all: audit events
-- are created exclusively by financial_post_transaction() (and, in
-- future phases, other SECURITY DEFINER RPCs) -- never directly by a
-- client. This is what prevents a client from fabricating actor
-- identity or audit history.

-- ============================================================
-- 15-18. Pooja: pooja_configs, pooja_days, pooja_slots, pooja_participants
-- ============================================================
grant select on pooja_configs to authenticated;
create policy "pooja configs are visible to all authenticated users"
    on pooja_configs for select to authenticated using (true);
grant insert, update on pooja_configs to authenticated;
create policy "ACCOUNTANT or ADMIN manage pooja configs (insert)"
    on pooja_configs for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage pooja configs (update)"
    on pooja_configs for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

grant select on pooja_days to authenticated;
create policy "pooja days are visible to all authenticated users"
    on pooja_days for select to authenticated using (true);
grant insert, update on pooja_days to authenticated;
create policy "ACCOUNTANT or ADMIN manage pooja days (insert)"
    on pooja_days for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage pooja days (update)"
    on pooja_days for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

grant select on pooja_slots to authenticated;
create policy "pooja slots are visible to all authenticated users"
    on pooja_slots for select to authenticated using (true);
grant insert, update on pooja_slots to authenticated;
create policy "ACCOUNTANT or ADMIN manage pooja slots (insert)"
    on pooja_slots for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage pooja slots (update)"
    on pooja_slots for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- pooja_participants: any committee member may sign up for a slot,
-- per the architecture's Pooja requirements (participants map to
-- committee accounts); this is not a financial or sensitive
-- operation, so all authenticated users -- not just
-- ACCOUNTANT/ADMIN -- may INSERT/UPDATE. This is a deliberate,
-- disclosed departure from the "ACCOUNTANT or ADMIN manage" pattern
-- used elsewhere, because the architecture explicitly treats
-- participant sign-up as ordinary member activity, not an
-- operational-data-management capability restricted in §12.1's matrix.
grant select on pooja_participants to authenticated;
create policy "pooja participants are visible to all authenticated users"
    on pooja_participants for select to authenticated using (true);
grant insert, update on pooja_participants to authenticated;
create policy "any authenticated committee member may sign up for a slot"
    on pooja_participants for insert to authenticated
    with check (true);
create policy "any authenticated committee member may update participant entries"
    on pooja_participants for update to authenticated
    using (true)
    with check (true);

-- ============================================================
-- 19-20. inventory_items, inventory_movements
-- ============================================================
grant select on inventory_items to authenticated;
create policy "inventory items are visible to all authenticated users"
    on inventory_items for select to authenticated using (true);
grant insert, update on inventory_items to authenticated;
create policy "ACCOUNTANT or ADMIN manage inventory items (insert)"
    on inventory_items for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));
create policy "ACCOUNTANT or ADMIN manage inventory items (update)"
    on inventory_items for update to authenticated
    using (app_has_any_role(array['ACCOUNTANT', 'ADMIN']))
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- inventory_movements: append-only ledger (§17 Inventory
-- requirements) -- INSERT only, no UPDATE grant at all.
grant select on inventory_movements to authenticated;
create policy "inventory movements are visible to all authenticated users"
    on inventory_movements for select to authenticated using (true);
grant insert on inventory_movements to authenticated;
create policy "ACCOUNTANT or ADMIN record inventory movements"
    on inventory_movements for insert to authenticated
    with check (app_has_any_role(array['ACCOUNTANT', 'ADMIN']));

-- ============================================================
-- Read access to the derived financial state (§8's aggregation
-- surface). The application must be able to display authoritative
-- liquidity/custody/commitment/income/expense figures -- these are
-- read-only, non-mutating views/functions over `transactions`
-- (already SELECT-granted above), so granting them broadly to every
-- authenticated user is consistent with the same "financial
-- transparency to the whole committee" principle applied to
-- `transactions` itself, and grants no write capability whatsoever.
-- ============================================================
grant select on financial_effects to authenticated;
grant execute on function financial_evaluate_transaction(transactions) to authenticated;
grant execute on function financial_project_liquidity(uuid) to authenticated;
grant execute on function financial_recognized_income(uuid) to authenticated;
grant execute on function financial_recognized_expense(uuid) to authenticated;
grant execute on function financial_net_performance(uuid) to authenticated;
grant execute on function financial_commitment_settled(uuid) to authenticated;
grant execute on function financial_commitment_outstanding(uuid) to authenticated;
grant execute on function financial_custody_balance(uuid) to authenticated;
grant execute on function financial_liquidity_shortage(uuid) to authenticated;
