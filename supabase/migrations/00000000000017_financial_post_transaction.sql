-- Phase 2B -- Authoritative Financial Effect Engine / PostgreSQL RPC Foundation
-- Migration 0017: financial_post_transaction (the controlled Financial RPC)
--
-- Source: architecturefinal-v4.5.1.md §4.4-§4.6 (PostgreSQL Functions/
-- RPC is the authoritative financial mutation layer), §5.1-§5.2
-- (atomic mutation contract, idempotency), §7-§10 (effect engine and
-- reversal engine), §8.3-§8.4 (commitment/custody preconditions).
--
-- This is the single authoritative entry point for ALL financial
-- mutations in this phase:
--
--   Authenticated caller -> financial_post_transaction() -> validation
--     -> FinancialEffectEngine.evaluate() -> atomic INSERT (transaction
--     + audit_events) -> POSTED transaction returned
--
-- INTERPRETATION NOTES (flagged, not silently invented):
--
-- 1. AUTHORIZATION: Supabase Auth session integration and the full
--    RBAC/maker-checker APPROVAL WORKFLOW (submit -> pending ->
--    approve/reject) are not implemented in this phase (Phase 2A/2B
--    exclusion lists; RLS policies are explicitly deferred). This RPC
--    therefore accepts `p_created_by_user_id` as an explicit
--    parameter standing in for the caller's authenticated identity
--    (to be replaced by `auth.uid()` once Supabase Auth is wired up
--    in a later phase), and accepts an optional `p_approved_by_user_id`
--    so a caller MAY tag an approver atomically at post time. The
--    schema's existing maker-checker CHECK constraint
--    (chk_tx_maker_checker) is still fully enforced either way. Every
--    transaction posted by this RPC has `status = 'POSTED'` directly
--    -- there is no DRAFT/PENDING_APPROVAL state machine in this
--    phase.
-- 2. REVERSAL attribution: per §10.2, source/destination project,
--    commitment, custody advance, and category are inherited from the
--    original transaction. donor_user_id/cash_handler_user_id are not
--    named in §10.2's attribution list; this implementation leaves
--    them NULL on the reversal row rather than inventing an
--    inheritance rule for fields the architecture does not mention.
--
-- SECURITY DEFINER is used so that, once RLS policies deny direct
-- table access to authenticated clients in a later phase, this
-- function can still perform the necessary reads/writes on their
-- behalf -- exactly the "controlled Financial RPC" model in §4.4.
-- `search_path` is pinned to prevent search-path hijacking.

create or replace function financial_post_transaction(
    p_idempotency_key                 text,
    p_transaction_type                text,
    p_created_by_user_id               uuid,
    p_amount_minor_units               bigint default null,
    p_recognized_amount_minor_units    bigint default null,
    p_source_project_id                uuid default null,
    p_destination_project_id           uuid default null,
    p_category_id                      uuid default null,
    p_commitment_id                    uuid default null,
    p_custody_advance_transaction_id   uuid default null,
    p_reverses_transaction_id          uuid default null,
    p_donor_user_id                    uuid default null,
    p_cash_handler_user_id             uuid default null,
    p_payment_source                   text default 'CASH',
    p_description                      text default '',
    p_transaction_date                 timestamptz default now(),
    p_approved_by_user_id              uuid default null,
    p_void_reason                      text default null,
    p_food_session_id                  uuid default null,
    p_funding_plan_id                  uuid default null
)
returns transactions
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existing            transactions;
    v_new                 transactions;
    v_original             transactions;
    v_commitment           commitments;
    v_disbursement          transactions;
    v_lock_ids              uuid[];
    v_lock_id               uuid;
    v_outstanding           bigint;
    v_custody_balance        bigint;
    v_amount                bigint := p_amount_minor_units;
    v_recognized             bigint := p_recognized_amount_minor_units;
    v_source                 uuid := p_source_project_id;
    v_destination             uuid := p_destination_project_id;
    v_commitment_id           uuid := p_commitment_id;
    v_custody_id              uuid := p_custody_advance_transaction_id;
    v_category_id             uuid := p_category_id;
    v_donor                  uuid := p_donor_user_id;
    v_handler                 uuid := p_cash_handler_user_id;
    v_source_project          projects;
    v_dest_project             projects;
    v_probe                   transactions;
    v_effect                  record;
    v_source_liquidity         bigint;
begin
    -- ------------------------------------------------------------
    -- 0. Idempotency (§5.1, Invariant 42). A repeated submission with
    --    the same idempotency key returns the original result and
    --    creates no new financial effect.
    -- ------------------------------------------------------------
    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'idempotency_key is required';
    end if;

    select * into v_existing from transactions where idempotency_key = p_idempotency_key;
    if found then
        return v_existing;
    end if;

    if p_transaction_type is null then
        raise exception 'transaction_type is required';
    end if;
    if p_created_by_user_id is null then
        raise exception 'created_by_user_id is required (Phase 2B interpretation note: stands in for the authenticated actor until Supabase Auth is wired up)';
    end if;

    -- ------------------------------------------------------------
    -- 1. REVERSAL: resolve authoritative routing + effects from the
    --    original transaction. Client-supplied amounts/routing for a
    --    REVERSAL are ignored entirely, per §10.1-§10.2.
    -- ------------------------------------------------------------
    if p_transaction_type = 'REVERSAL' then
        if p_reverses_transaction_id is null then
            raise exception 'REVERSAL requires reverses_transaction_id (§10.1 step 1)';
        end if;

        -- Lock the original row first: this serializes concurrent
        -- reversal attempts against the same original (Invariant 59).
        select * into v_original from transactions where id = p_reverses_transaction_id for update;
        if not found then
            raise exception 'REVERSAL references a non-existent original transaction %', p_reverses_transaction_id;
        end if;
        if v_original.status != 'POSTED' then
            raise exception 'REVERSAL may only target a POSTED transaction (§10.1 step 3, §8.5)';
        end if;
        if v_original.transaction_type = 'REVERSAL' then
            raise exception 'Chained reversals are not supported (§10.3): % is itself a REVERSAL', p_reverses_transaction_id;
        end if;

        if exists (
            select 1 from transactions
             where reverses_transaction_id = p_reverses_transaction_id and status = 'POSTED'
        ) then
            raise exception 'Transaction % already has an active POSTED reversal (§10.3 Reversal Uniqueness, Invariant 59)', p_reverses_transaction_id;
        end if;

        -- Routing and amounts are entirely inherited (§10.2), never
        -- taken from the caller's arguments.
        v_source := v_original.source_project_id;
        v_destination := v_original.destination_project_id;
        v_commitment_id := v_original.commitment_id;
        v_custody_id := v_original.custody_advance_transaction_id;
        v_category_id := v_original.category_id;
        v_amount := v_original.amount_minor_units;
        v_recognized := v_original.recognized_amount_minor_units;
        v_donor := null;
        v_handler := null;
    else
        if p_reverses_transaction_id is not null then
            raise exception 'reverses_transaction_id may only be set on a REVERSAL transaction';
        end if;
        if v_amount is null or v_amount <= 0 then
            raise exception 'amount_minor_units must be a positive integer';
        end if;
    end if;

    -- ------------------------------------------------------------
    -- 2. Closed-project rejection (Invariant 39), except for
    --    REVERSAL: §17.9 explicitly requires the reversal mechanism
    --    to remain available for post-closure corrections.
    -- ------------------------------------------------------------
    if p_transaction_type != 'REVERSAL' then
        if v_source is not null then
            select * into v_source_project from projects where id = v_source;
            if not found then
                raise exception 'source_project_id % does not exist', v_source;
            end if;
            if v_source_project.status = 'CLOSED' then
                raise exception 'Project % is CLOSED and rejects normal financial mutation (Invariant 39, §17.7)', v_source;
            end if;
        end if;
        if v_destination is not null then
            select * into v_dest_project from projects where id = v_destination;
            if not found then
                raise exception 'destination_project_id % does not exist', v_destination;
            end if;
            if v_dest_project.status = 'CLOSED' then
                raise exception 'Project % is CLOSED and rejects normal financial mutation (Invariant 39, §17.7)', v_destination;
            end if;
        end if;
    end if;

    -- ------------------------------------------------------------
    -- 3. General Reserve participation restriction: GENERAL_RESERVE
    --    may only participate via INTERNAL_FUND_TRANSFER (§6 General
    --    Reserve Protection Invariant, Invariant 65). REVERSAL is
    --    exempt from this re-check: it inherits the original's type,
    --    and if the original was validly posted, it was already
    --    validated at that time.
    -- ------------------------------------------------------------
    if p_transaction_type not in ('REVERSAL', 'INTERNAL_FUND_TRANSFER') then
        if (v_source is not null and exists (select 1 from projects where id = v_source and is_general_reserve))
           or (v_destination is not null and exists (select 1 from projects where id = v_destination and is_general_reserve))
        then
            raise exception 'General Reserve may only participate in INTERNAL_FUND_TRANSFER transactions (§6 General Reserve Protection Invariant)';
        end if;
    end if;

    -- ------------------------------------------------------------
    -- 4. Deadlock-safe project row locking (proxy lock for the
    --    derived liquidity aggregate -- there is no stored balance
    --    column to lock directly). Lock in ascending id order so
    --    that two transfers between the same pair of projects, in
    --    either direction, always acquire locks in the same order.
    -- ------------------------------------------------------------
    v_lock_ids := array[]::uuid[];
    if v_source is not null then
        v_lock_ids := array_append(v_lock_ids, v_source);
    end if;
    if v_destination is not null then
        v_lock_ids := array_append(v_lock_ids, v_destination);
    end if;
    if array_length(v_lock_ids, 1) > 0 then
        for v_lock_id in select unnest(v_lock_ids) order by 1 loop
            perform 1 from projects where id = v_lock_id for update;
        end loop;
    end if;

    -- ------------------------------------------------------------
    -- 5. Commitment validation (§8.3), except for REVERSAL (already
    --    validated when the original was posted).
    -- ------------------------------------------------------------
    if p_transaction_type != 'REVERSAL' and v_commitment_id is not null then
        select * into v_commitment from commitments where id = v_commitment_id for update;
        if not found then
            raise exception 'commitment_id % does not exist', v_commitment_id;
        end if;
        if v_commitment.is_cancelled then
            raise exception 'commitment_id % is cancelled and cannot be settled', v_commitment_id;
        end if;

        -- Commitment Direction & Project Validation (§8.3).
        if v_commitment.direction = 'OUTFLOW' then
            if p_transaction_type not in ('EXPENSE_ADVANCE', 'EXPENSE_SETTLEMENT') then
                raise exception 'An OUTFLOW commitment can only be settled by EXPENSE_ADVANCE/EXPENSE_SETTLEMENT (§8.3 Commitment Direction & Project Validation), not %', p_transaction_type;
            end if;
            if v_source is distinct from v_commitment.project_id then
                raise exception 'Transaction source_project_id must match the OUTFLOW commitment''s project (§8.3)';
            end if;
        elsif v_commitment.direction = 'INFLOW' then
            if p_transaction_type != 'DONATION_AUCTION' then
                raise exception 'An INFLOW commitment can only be settled by DONATION_AUCTION (§8.3 Commitment Direction & Project Validation), not %', p_transaction_type;
            end if;
            if v_destination is distinct from v_commitment.project_id then
                raise exception 'Transaction destination_project_id must match the INFLOW commitment''s project (§8.3)';
            end if;
        end if;

        -- Commitment Settlement Bound (§8.3 precondition, not a clamp).
        if p_transaction_type in ('EXPENSE_ADVANCE', 'EXPENSE_SETTLEMENT', 'DONATION_AUCTION') then
            v_outstanding := financial_commitment_outstanding(v_commitment_id);
            if v_amount > v_outstanding then
                raise exception 'Settlement amount % exceeds outstanding commitment amount % for commitment % (§8.3 Commitment Settlement Bound)',
                    v_amount, v_outstanding, v_commitment_id;
            end if;
        end if;
    end if;

    -- ------------------------------------------------------------
    -- 6. Custody validation (§8.4), except for REVERSAL.
    -- ------------------------------------------------------------
    if p_transaction_type != 'REVERSAL' and v_custody_id is not null then
        select * into v_disbursement from transactions where id = v_custody_id for update;
        if not found or v_disbursement.transaction_type != 'INTERNAL_CASH_DISBURSEMENT' then
            raise exception 'custody_advance_transaction_id % is not a valid custody advance (§8.4 Custody Type Validation)', v_custody_id;
        end if;
        if v_disbursement.status != 'POSTED' then
            raise exception 'custody_advance_transaction_id % must reference a POSTED disbursement (§8.4)', v_custody_id;
        end if;

        -- The disbursement's own project must match "the project this
        -- custody-linked transaction operates within": for
        -- EXPENSE_DIRECT/ADVANCE/SETTLEMENT that is source_project_id
        -- (money is being spent FROM that project's custody-holder);
        -- for INTERNAL_CASH_RETURN it is destination_project_id
        -- (money returns TO that project).
        if p_transaction_type = 'INTERNAL_CASH_RETURN' then
            if v_disbursement.source_project_id is distinct from v_destination then
                raise exception 'INTERNAL_CASH_RETURN destination_project_id must match the disbursement''s project (§8.4 Custody Type Validation)';
            end if;
        else
            if v_disbursement.source_project_id is distinct from v_source then
                raise exception 'Custody-linked transaction source_project_id must match the disbursement''s project (§8.4 Custody Type Validation)';
            end if;
        end if;

        if v_disbursement.cash_handler_user_id is distinct from v_handler then
            raise exception 'Custody-linked transaction cash_handler_user_id must match the disbursement''s handler (§8.4 Custody Type Validation)';
        end if;

        v_custody_balance := financial_custody_balance(v_custody_id);
        if v_amount > v_custody_balance then
            raise exception 'Amount % exceeds outstanding custody balance % for advance % (§8.4 Custody Consumption Bound / Bounded Return, Invariant 12/60)',
                v_amount, v_custody_balance, v_custody_id;
        end if;
    end if;

    -- ------------------------------------------------------------
    -- 6.5. Project liquidity bound (Invariant 21 "Source Liquidity
    --      Bound", Invariant 22 "Anti-Overdraft Concurrency"). Runs
    --      after the structural/routing checks above (5-6) so a
    --      request that is invalid for shape/routing reasons is
    --      rejected with that specific reason rather than an
    --      incidental liquidity error. Rather than re-deriving which
    --      transaction types reduce liquidity by how much, this
    --      builds an in-memory "probe" row with the already-resolved
    --      routing/amount fields (including, for a REVERSAL, the
    --      inherited original routing/amounts) and runs it through
    --      the SAME FinancialEffectEngine evaluator used for the real
    --      posted row -- there is exactly one place that knows each
    --      transaction type's liquidity effect (§8's
    --      aggregation-authority rule extends to this RPC itself: no
    --      second, duplicated effect-calculation path).
    -- ------------------------------------------------------------
    v_probe.transaction_type := p_transaction_type;
    v_probe.amount_minor_units := v_amount;
    v_probe.recognized_amount_minor_units := v_recognized;
    v_probe.custody_advance_transaction_id := v_custody_id;
    v_probe.commitment_id := v_commitment_id;
    v_probe.reverses_transaction_id := p_reverses_transaction_id;

    select * into v_effect from financial_evaluate_transaction(v_probe);

    if v_effect.src_liquidity < 0 and v_source is not null then
        v_source_liquidity := financial_project_liquidity(v_source);
        if v_source_liquidity + v_effect.src_liquidity < 0 then
            raise exception 'Insufficient liquidity in project %: available %, requested reduction % (Invariant 21 Source Liquidity Bound, Invariant 22 Anti-Overdraft Concurrency)',
                v_source, v_source_liquidity, -v_effect.src_liquidity;
        end if;
    end if;

    -- Symmetric check: a REVERSAL of an inflow transaction (e.g.
    -- reversing a DONATION_MEMBER) has a negative dest_liquidity
    -- effect. The same anti-overdraft principle applies: a project's
    -- liquidity may never be driven negative, regardless of which
    -- side of the vector the reduction appears on.
    if v_effect.dest_liquidity < 0 and v_destination is not null then
        v_source_liquidity := financial_project_liquidity(v_destination);
        if v_source_liquidity + v_effect.dest_liquidity < 0 then
            raise exception 'Insufficient liquidity in project %: available %, requested reduction % (Invariant 21/22 applied symmetrically to a reversed inflow)',
                v_destination, v_source_liquidity, -v_effect.dest_liquidity;
        end if;
    end if;

    -- ------------------------------------------------------------
    -- 7. Insert the transaction row. All remaining shape rules
    --    (donation/expense/transfer routing, maker-checker,
    --    void-reason, custody whitelist, etc.) are enforced by the
    --    Phase 2A CHECK constraints already present on this table --
    --    this RPC does not duplicate them, it adds only the
    --    cross-row validations a CHECK constraint cannot express.
    -- ------------------------------------------------------------
    insert into transactions (
        source_project_id, destination_project_id, category_id, commitment_id,
        custody_advance_transaction_id, reverses_transaction_id, food_session_id,
        funding_plan_id, transaction_type, description, amount_minor_units,
        recognized_amount_minor_units, payment_source, donor_user_id,
        cash_handler_user_id, transaction_date, status, created_by_user_id,
        created_at, approved_by_user_id, approval_timestamp, void_reason,
        idempotency_key, client_timestamp
    ) values (
        v_source, v_destination, v_category_id, v_commitment_id,
        v_custody_id, p_reverses_transaction_id, p_food_session_id,
        p_funding_plan_id, p_transaction_type, p_description, v_amount,
        v_recognized, p_payment_source, v_donor,
        v_handler, p_transaction_date, 'POSTED', p_created_by_user_id,
        now(), p_approved_by_user_id, (case when p_approved_by_user_id is not null then now() end),
        p_void_reason, p_idempotency_key, now()
    )
    returning * into v_new;

    -- ------------------------------------------------------------
    -- 8. Immutable audit trail (§6 entity 14, Invariant 40/41).
    --    server_global_sequence and id are database-generated; the
    --    client never supplies or influences audit ordering.
    -- ------------------------------------------------------------
    insert into audit_events (
        entity_type, entity_id, action_type, actor_user_id,
        entity_version, after_state_json, client_timestamp
    ) values (
        'transactions', v_new.id,
        (case when p_transaction_type = 'REVERSAL' then 'REVERSE' else 'POST' end),
        p_created_by_user_id, 1, to_jsonb(v_new), now()
    );

    return v_new;
end;
$$;

comment on function financial_post_transaction is
    'The sole controlled Financial RPC for Phase 2B (§4.4). Client-side code must call this function rather than writing to transactions/audit_events directly.';
