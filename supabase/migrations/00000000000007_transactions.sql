-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0007: transactions
--
-- Source: architecturefinal-v4.5.1.md §6, entity 12 ("Transactions --
-- Unified financial & custody ledger").
--
-- IMPORTANT: this migration creates the STRUCTURE of the ledger table
-- only, including its routing/shape CHECK constraints exactly as
-- specified in §6. It does NOT implement the FinancialEffectEngine,
-- the 7-effect vector, or any posting/RPC logic (§7-§10) -- those are
-- explicitly out of scope for Phase 2A. No row in this table is
-- financially "true" until a later phase's Financial RPC evaluates
-- and posts it; this migration only ensures the ledger cannot even be
-- shaped incorrectly at the structural level.
--
-- transaction_type and status are intentionally plain `text` (not a
-- CHECK IN (...) list or an enum type) per §6.2's explicit,
-- deliberate design decision -- the client and server-side Financial
-- RPC are the authoritative validators of the enumerated value itself.
-- The CHECK constraints below validate structural *shape* (which
-- columns must/must not be populated together for a given
-- transaction_type), which IS explicitly required by §6's own SQL.

create table transactions (
    id                              uuid primary key not null default gen_random_uuid(),
    source_project_id               uuid references projects(id) on delete restrict,
    destination_project_id          uuid references projects(id) on delete restrict,
    category_id                     uuid references project_categories(id) on delete restrict,
    commitment_id                   uuid references commitments(id) on delete restrict,
    custody_advance_transaction_id  uuid references transactions(id) on delete restrict,
    reverses_transaction_id         uuid references transactions(id) on delete restrict,
    food_session_id                 uuid references food_sessions(id) on delete set null,
    funding_plan_id                 uuid references additional_funding_plans(id) on delete restrict,
    transaction_type                text not null,
    description                     text not null,
    amount_minor_units              integer not null check (amount_minor_units > 0), -- Physical cash movement / settlement payment
    recognized_amount_minor_units   integer check (recognized_amount_minor_units is null or recognized_amount_minor_units > 0), -- Explicit economic recognized expense
    payment_source                  text not null, -- CASH, BANK, UPI
    donor_user_id                   uuid references users(id) on delete restrict,
    cash_handler_user_id            uuid references users(id) on delete restrict,
    transaction_date                timestamptz not null,
    status                          text not null, -- DRAFT, PENDING_APPROVAL, POSTED, REJECTED, VOIDED
    created_by_user_id              uuid not null references users(id) on delete restrict,
    created_at                      timestamptz not null,
    submitted_at                    timestamptz,
    approved_by_user_id             uuid references users(id) on delete restrict,
    approval_timestamp              timestamptz,
    rejection_reason                text,
    rejection_timestamp             timestamptz,
    void_reason                     text,
    current_version                 integer not null default 1,
    is_deleted                      boolean not null default false,
    idempotency_key                 text unique not null,
    client_timestamp                timestamptz not null,
    server_timestamp                timestamptz,

    -- Maker-Checker Invariant. Source: §13 Invariant 36.
    constraint chk_tx_maker_checker
        check (approved_by_user_id is null or created_by_user_id != approved_by_user_id),

    -- DONATION routing rules.
    constraint chk_tx_donation_routing
        check (transaction_type not like 'DONATION_%' or (destination_project_id is not null and source_project_id is null and recognized_amount_minor_units is null)),
    constraint chk_tx_donation_member_donor
        check (transaction_type != 'DONATION_MEMBER' or donor_user_id is not null),
    constraint chk_tx_donation_public_no_donor
        check (transaction_type != 'DONATION_PUBLIC' or donor_user_id is null),

    -- EXPENSE routing rules.
    constraint chk_tx_expense_routing
        check (transaction_type not like 'EXPENSE_%' or (source_project_id is not null and destination_project_id is null)),
    constraint chk_tx_expense_advance_shape
        check (transaction_type != 'EXPENSE_ADVANCE' or (commitment_id is not null and recognized_amount_minor_units is null)),
    constraint chk_tx_expense_settlement_shape
        check (transaction_type != 'EXPENSE_SETTLEMENT' or commitment_id is not null),

    -- TEMPLE / VILLAGE DONATION OUT.
    constraint chk_tx_temple_village_donation_out_shape
        check (transaction_type != 'TEMPLE_VILLAGE_DONATION_OUT' or (source_project_id is not null and destination_project_id is null and recognized_amount_minor_units is null)),

    -- INTERNAL FUND TRANSFER routing.
    constraint chk_tx_internal_fund_transfer_shape
        check (transaction_type != 'INTERNAL_FUND_TRANSFER' or (source_project_id is not null and destination_project_id is not null and source_project_id != destination_project_id and recognized_amount_minor_units is null)),

    -- REVERSAL must reference original. Source: §10.1-§10.3.
    constraint chk_tx_reversal_requires_original
        check (transaction_type != 'REVERSAL' or reverses_transaction_id is not null),
    constraint chk_tx_only_reversal_has_original
        check (transaction_type = 'REVERSAL' or reverses_transaction_id is null),

    -- Custody routing & whitelisting. Source: §8.4, §7 custody-linked
    -- variants. REVERSAL is included here (Phase 2B correction) because
    -- a REVERSAL of a custody-linked EXPENSE_DIRECT/EXPENSE_ADVANCE/
    -- EXPENSE_SETTLEMENT/INTERNAL_CASH_RETURN legitimately inherits
    -- that original's custody_advance_transaction_id verbatim (§10.2
    -- attribution inheritance) -- without REVERSAL in this whitelist,
    -- reversing any custody-linked transaction was structurally
    -- impossible, which contradicts §10's universal reversal engine
    -- applying to every transaction type without exception.
    constraint chk_tx_custody_link_whitelist
        check (custody_advance_transaction_id is null or transaction_type in ('EXPENSE_DIRECT', 'EXPENSE_ADVANCE', 'EXPENSE_SETTLEMENT', 'INTERNAL_CASH_RETURN', 'REVERSAL')),
    constraint chk_tx_internal_cash_disbursement_shape
        check (transaction_type != 'INTERNAL_CASH_DISBURSEMENT' or (source_project_id is not null and destination_project_id is null and cash_handler_user_id is not null and recognized_amount_minor_units is null)),
    constraint chk_tx_internal_cash_return_shape
        check (transaction_type != 'INTERNAL_CASH_RETURN' or (source_project_id is null and destination_project_id is not null and cash_handler_user_id is not null and recognized_amount_minor_units is null and custody_advance_transaction_id is not null)),

    -- VOID requires reason.
    constraint chk_tx_void_requires_reason
        check (status != 'VOIDED' or void_reason is not null)
);

create index idx_transactions_routing on transactions(source_project_id, destination_project_id, status);
create index idx_transactions_commitment on transactions(commitment_id);
create index idx_transactions_custody on transactions(custody_advance_transaction_id);
create index idx_transactions_reversal on transactions(reverses_transaction_id);
create index idx_transactions_donor on transactions(donor_user_id);
create index idx_transactions_handler on transactions(cash_handler_user_id);

comment on table transactions is
    'Unified financial & custody ledger (§6). Structural/routing shape only in Phase 2A -- the FinancialEffectEngine, 7-effect vector, and posting workflow are NOT implemented yet (§7-§10, later phases).';
comment on column transactions.idempotency_key is
    'Preserves request/submission idempotency without the removed offline sync queue (§6 sync_operations removal note, §13 Invariant 42).';
comment on constraint chk_tx_internal_cash_return_shape on transactions is
    'Includes the Finding-2 hardening fix from the architecture review: custody_advance_transaction_id is mandatory (NOT NULL) for INTERNAL_CASH_RETURN so §8.4''s return bound is always computable (§13 Invariant 12, Invariant 63).';
