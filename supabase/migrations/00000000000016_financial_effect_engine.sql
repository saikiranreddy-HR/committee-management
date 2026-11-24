-- Phase 2B -- Authoritative Financial Effect Engine / PostgreSQL RPC Foundation
-- Migration 0016: FinancialEffectEngine core evaluator + derived-value functions
--
-- PHASE 2D SECURITY HARDENING NOTE: every function below now pins
-- `set search_path = public`. This was added retroactively (this
-- migration had never been deployed) after the Phase 2D security
-- review explicitly checked for search_path vulnerabilities and found
-- these functions -- while SECURITY INVOKER, not DEFINER, and
-- therefore lower severity -- lacked the pin recommended for any
-- function that queries tables by unqualified name. Pinning prevents
-- a session with an unusual search_path from causing these functions
-- to resolve `transactions`/`commitments`/`financial_effects` to an
-- unexpected object.
--
-- Source: architecturefinal-v4.5.1.md §7 (7-Effect Financial Effect
-- Vector Matrix), §8 (Authoritative Financial Equations &
-- Derivations), §10 (Universal Reversal Engine).
--
-- ============================================================
-- FLAGGED CONTRADICTION (reported, not silently resolved):
-- ============================================================
-- The Phase 2B task prompt's "CRITICAL FINANCIAL MODEL" section lists
-- a 7-effect model as: Cash Movement, Recognized Income, Recognized
-- Expense, Commitment Change, Source Liquidity, Cash Custody, and
-- "PROJECT CLOSURE" as the 7th effect. This does not match the
-- frozen architecture, which defines the 7 effects as: (1) Cash
-- Movement, (2) Destination Liquidity, (3) Source Liquidity,
-- (4) Recognized Income, (5) Recognized Expense, (6) Cash Custody,
-- (7) Commitment Settlement (§7). "Project Closure" is NOT one of
-- the 7 effects anywhere in the architecture -- §17.6 explicitly
-- states closure "creates NO financial effect" of any kind, and the
-- same Phase 2B prompt separately instructs "Do NOT implement
-- project closure in this phase." Implementing a "PROJECT CLOSURE"
-- effect would therefore contradict both the frozen architecture and
-- the prompt's own exclusion list.
--
-- Per this task's own instruction ("If the architecture does not
-- specify something required for implementation, STOP and report the
-- ambiguity rather than inventing a financial rule") and the standing
-- instruction to treat the architecture document as the sole
-- authoritative source, this migration implements the ACTUAL 7
-- effects from §7 (including the "Destination Liquidity" effect the
-- prompt's list omitted), not the prompt's paraphrased list. See the
-- Phase 2B final report for this disclosure.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Core evaluator: FinancialEffectEngine.evaluate(transaction)
-- ------------------------------------------------------------
-- Given one transaction row, returns its immutable 7-effect vector
-- exactly as defined by §7's matrix (including the custody-linked
-- variants for EXPENSE_DIRECT/EXPENSE_ADVANCE/EXPENSE_SETTLEMENT, and
-- REVERSAL's mathematical negation of the original's vector, per
-- §10.1). This function performs NO validation and NO side effects --
-- it is a pure, deterministic mapping from a transaction row to its
-- effect vector, matching the architecture's explicit division of
-- responsibility (§8: "FinancialEffectEngine defines HOW each
-- transaction's effects are produced").
create or replace function financial_evaluate_transaction(t transactions)
returns table (
    cash_movement       bigint,
    dest_liquidity      bigint,
    src_liquidity       bigint,
    recognized_income   bigint,
    recognized_expense  bigint,
    cash_custody        bigint,
    commitment_settle   bigint
)
language plpgsql
stable
set search_path = public
as $$
declare
    a                  bigint := t.amount_minor_units;
    r                  bigint := coalesce(t.recognized_amount_minor_units, t.amount_minor_units);
    is_custody_linked  boolean := t.custody_advance_transaction_id is not null;
    original           transactions;
    original_effect    record;
begin
    case t.transaction_type
        when 'DONATION_MEMBER', 'DONATION_PUBLIC' then
            return query select a, a, 0::bigint, a, 0::bigint, 0::bigint, 0::bigint;

        when 'DONATION_AUCTION' then
            return query select
                a, a, 0::bigint, a, 0::bigint, 0::bigint,
                (case when t.commitment_id is not null then a else 0 end)::bigint;

        when 'INTERNAL_FUND_TRANSFER' then
            return query select a, a, -a, 0::bigint, 0::bigint, 0::bigint, 0::bigint;

        when 'INTERNAL_CASH_DISBURSEMENT' then
            return query select -a, 0::bigint, -a, 0::bigint, 0::bigint, a, 0::bigint;

        when 'INTERNAL_CASH_RETURN' then
            return query select a, a, 0::bigint, 0::bigint, 0::bigint, -a, 0::bigint;

        when 'EXPENSE_DIRECT' then
            if is_custody_linked then
                return query select 0::bigint, 0::bigint, 0::bigint, 0::bigint, r, -a, 0::bigint;
            else
                return query select -a, 0::bigint, -a, 0::bigint, r, 0::bigint, 0::bigint;
            end if;

        when 'EXPENSE_ADVANCE' then
            -- Recognized expense is always 0 (deferred) for
            -- EXPENSE_ADVANCE regardless of custody linkage -- §8.0,
            -- and enforced independently by the
            -- recognized_amount_minor_units IS NULL shape constraint.
            if is_custody_linked then
                return query select 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, -a, a;
            else
                return query select -a, 0::bigint, -a, 0::bigint, 0::bigint, 0::bigint, a;
            end if;

        when 'EXPENSE_SETTLEMENT' then
            if is_custody_linked then
                return query select 0::bigint, 0::bigint, 0::bigint, 0::bigint, r, -a, a;
            else
                return query select -a, 0::bigint, -a, 0::bigint, r, 0::bigint, a;
            end if;

        when 'TEMPLE_VILLAGE_DONATION_OUT' then
            return query select -a, 0::bigint, -a, 0::bigint, a, 0::bigint, 0::bigint;

        when 'REVERSAL' then
            select * into original from transactions where id = t.reverses_transaction_id;
            if original.id is null then
                raise exception 'REVERSAL % references a non-existent original transaction %',
                    t.id, t.reverses_transaction_id;
            end if;

            select * into original_effect from financial_evaluate_transaction(original);

            return query select
                -original_effect.cash_movement,
                -original_effect.dest_liquidity,
                -original_effect.src_liquidity,
                -original_effect.recognized_income,
                -original_effect.recognized_expense,
                -original_effect.cash_custody,
                -original_effect.commitment_settle;

        else
            raise exception 'financial_evaluate_transaction: unknown transaction_type "%"', t.transaction_type;
    end case;
end;
$$;

comment on function financial_evaluate_transaction is
    'FinancialEffectEngine.evaluate() -- pure 7-effect vector mapping per architecturefinal-v4.5.1.md §7. No validation, no side effects.';

-- ------------------------------------------------------------
-- 2. FinancialDomainEngine aggregation surface
-- ------------------------------------------------------------
-- One row per transaction, carrying its evaluated 7-effect vector
-- alongside its routing attribution. This view IS the
-- "7-effect Financial Effect Vector" stage of the architecture's
-- pipeline (§8): POSTED TRANSACTION -> FinancialEffectEngine.evaluate()
-- -> [this view] -> FinancialDomainEngine aggregation (the functions
-- below). No downstream consumer may bypass this view to reclassify
-- transaction types independently (§8's aggregation-authority rule).
create view financial_effects as
select
    t.id as transaction_id,
    t.status,
    t.transaction_type,
    t.source_project_id,
    t.destination_project_id,
    t.commitment_id,
    t.custody_advance_transaction_id,
    e.cash_movement,
    e.dest_liquidity,
    e.src_liquidity,
    e.recognized_income,
    e.recognized_expense,
    e.cash_custody,
    e.commitment_settle,
    t.reverses_transaction_id
from transactions t
cross join lateral financial_evaluate_transaction(t) as e;

comment on view financial_effects is
    'The FinancialDomainEngine aggregation surface (§8). Every derived financial value in this system is computed from this view -- never independently reclassified from raw transaction rows. `reverses_transaction_id` is exposed (as a trailing column, appended here rather than reordered, to remain CREATE OR REPLACE VIEW-compatible) specifically so aggregation functions can find a REVERSAL of a given transaction even when that transaction itself has no custody/commitment linkage of its own -- see financial_custody_balance''s Phase 2B correction note.';


-- ------------------------------------------------------------
-- 3. Derived values (§8.1, §8.2, §8.3, §8.4)
-- ------------------------------------------------------------

-- §8.2 Project Liquidity.
create or replace function financial_project_liquidity(p_project_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select coalesce(sum(
        case when destination_project_id = p_project_id then dest_liquidity else 0 end
        + case when source_project_id = p_project_id then src_liquidity else 0 end
    ), 0)
    from financial_effects
    where status = 'POSTED'
      and (source_project_id = p_project_id or destination_project_id = p_project_id);
$$;

comment on function financial_project_liquidity is
    'PROJECT_LIQUIDITY(p) per §8.2. Custody-linked expense/advance/settlement variants contribute 0 by construction (§7), so no separate exclusion clause is needed here -- the exclusion already lives in financial_evaluate_transaction.';

-- §8.1 Net Performance (recognized income vs. recognized expense).
create or replace function financial_recognized_income(p_project_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select coalesce(sum(recognized_income), 0)
    from financial_effects
    where status = 'POSTED' and destination_project_id = p_project_id;
$$;

create or replace function financial_recognized_expense(p_project_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select coalesce(sum(recognized_expense), 0)
    from financial_effects
    where status = 'POSTED' and source_project_id = p_project_id;
$$;

create or replace function financial_net_performance(p_project_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select financial_recognized_income(p_project_id) - financial_recognized_expense(p_project_id);
$$;

comment on function financial_net_performance is
    'NET_PERFORMANCE(p) per §8.1. Negative = performance deficit (§9 point 1). Distinct from liquidity shortage -- see financial_liquidity_shortage.';

-- §8.3 Commitment settlement / outstanding.
create or replace function financial_commitment_settled(p_commitment_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select coalesce(sum(commitment_settle), 0)
    from financial_effects
    where status = 'POSTED' and commitment_id = p_commitment_id;
$$;

create or replace function financial_commitment_outstanding(p_commitment_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select greatest(0, c.committed_amount_minor_units - financial_commitment_settled(c.id))
    from commitments c
    where c.id = p_commitment_id;
$$;

comment on function financial_commitment_outstanding is
    'currentOutstandingCommitment(c) per §8.3. Never negative by construction (greatest(0, ...)) -- over-settlement is prevented as a precondition in the posting RPC, not clamped here.';

-- §8.4 Member cash custody.
--
-- PHASE 2B CORRECTION (custody/reversal consistency bug): a REVERSAL
-- of the INTERNAL_CASH_DISBURSEMENT itself inherits
-- custody_advance_transaction_id from the original disbursement
-- (§10.2 attribution inheritance) -- but the disbursement's own
-- custody_advance_transaction_id is always NULL (it CREATES a custody
-- advance, it does not reference one), so that reversal's -A cash
-- custody effect was previously invisible to this function: neither
-- `transaction_id = p_disbursement_id` (it is a different row) nor
-- `custody_advance_transaction_id = p_disbursement_id` (it inherited
-- NULL, not the disbursement's id) matched it. The third clause below
-- closes this gap by also summing the cash_custody effect of any
-- POSTED transaction whose reverses_transaction_id is this specific
-- disbursement. This cannot double-count: only a REVERSAL of the
-- disbursement itself can ever have reverses_transaction_id equal to
-- the disbursement's id, and such a row's own
-- custody_advance_transaction_id is always NULL (never
-- p_disbursement_id), so it can never also match the second clause.
-- Reversals of custody-linked EXPENSE_DIRECT/EXPENSE_ADVANCE/
-- EXPENSE_SETTLEMENT/INTERNAL_CASH_RETURN are unaffected by this
-- change and remain correctly captured by the second clause alone,
-- because those originals already carry
-- custody_advance_transaction_id = the disbursement's id, which their
-- reversals inherit unchanged.
create or replace function financial_custody_balance(p_disbursement_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select
        coalesce(
            (select cash_custody from financial_effects
              where transaction_id = p_disbursement_id and status = 'POSTED'), 0)
        + coalesce(
            (select sum(cash_custody) from financial_effects
              where custody_advance_transaction_id = p_disbursement_id and status = 'POSTED'), 0)
        + coalesce(
            (select sum(cash_custody) from financial_effects
              where reverses_transaction_id = p_disbursement_id and status = 'POSTED'), 0);
$$;

comment on function financial_custody_balance is
    'custody_balance(advance) per §8.4: Cash Disbursed - Cash Spent - Cash Returned, all read from the same financial_effects view. Includes a REVERSAL of the disbursement itself (Phase 2B correction) -- see the inline comment above this function for why that third term is necessary and cannot double-count.';

-- §9: Liquidity shortage (distinct from performance deficit above).
create or replace function financial_liquidity_shortage(p_project_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
    select greatest(0, coalesce((
        select sum(financial_commitment_outstanding(c.id))
        from commitments c
        where c.project_id = p_project_id and c.direction = 'OUTFLOW' and c.is_cancelled = false
    ), 0) - financial_project_liquidity(p_project_id));
$$;

comment on function financial_liquidity_shortage is
    'Liquidity shortage per §9 point 2: outstanding OUTFLOW payables exceeding spendable liquidity, even when NET_PERFORMANCE is positive. Distinct from financial_net_performance.';
