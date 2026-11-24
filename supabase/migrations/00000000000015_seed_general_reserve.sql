-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0015: seed the single General Reserve project
--
-- Source: architecturefinal-v4.5.1.md §6 General Reserve Protection
-- Invariant ("Exactly one project may ever have is_general_reserve =
-- true"); §13 Invariant 65.
--
-- INTERPRETATION NOTE (flagged in the Phase 2A final report): the
-- architecture requires that exactly one General Reserve project
-- exists, but does not specify seed values for `name`, `type`,
-- `status`, `start_date`, or `end_date` -- these fields exist on
-- every `projects` row (including the General Reserve) but are
-- naturally bounded-festival concepts (a start/end date, a lifecycle
-- ending in CLOSED) that do not obviously apply to a perpetual root
-- pool. This migration seeds reasonable, minimal, non-financial
-- values:
--   - name:       'General Reserve'
--   - type:       'GENERAL_RESERVE' (matches the documented enum value)
--   - status:     'ACTIVE' (the General Reserve is permanently
--                 operative; it can never reach CLOSED, per the
--                 chk_general_reserve_not_closed constraint in
--                 migration 0002, so ACTIVE is the only lifecycle
--                 value consistent with that constraint)
--   - start_date: the time this migration is applied
--   - end_date:   a distant sentinel date (9999-12-31), since the
--                 General Reserve has no defined end
--
-- This seeds no financial transactions and sets no liquidity value --
-- liquidity remains, as for every project, purely derived from
-- POSTED transactions once the Financial RPC layer exists (§8.2).
-- The insert is guarded to be safe to re-run.

insert into projects (
    name,
    type,
    start_date,
    end_date,
    status,
    is_general_reserve,
    client_timestamp
)
select
    'General Reserve',
    'GENERAL_RESERVE',
    now(),
    timestamptz '9999-12-31 00:00:00+00',
    'ACTIVE',
    true,
    now()
where not exists (
    select 1 from projects where is_general_reserve = true
);
