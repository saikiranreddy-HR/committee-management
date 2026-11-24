-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0013: immutability triggers
--
-- Source: architecturefinal-v4.5.1.md §6.1 ("Physical deletion of
-- projects, transactions, commitments, audit events, or users is
-- strictly prohibited"); §13 Invariant 40 ("Physical Delete Ban");
-- §6 entity 14 comment ("Audit Events ... STRICTLY APPEND ONLY").
--
-- These triggers make an already-explicit architectural requirement
-- structurally impossible to violate, rather than relying solely on
-- application-level convention. Soft deletion continues to work
-- exactly as designed: `projects.is_deleted` / `commitments.is_deleted`
-- / `transactions.is_deleted` remain ordinary updatable boolean
-- columns -- only actual SQL DELETE (and, for audit_events, UPDATE)
-- statements are blocked.

create or replace function forbid_physical_delete()
returns trigger
language plpgsql
as $$
begin
    raise exception
        'Physical deletion of % is not permitted (architecturefinal-v4.5.1.md §6.1, §13 Invariant 40). Use the row''s logical-deletion flag instead.',
        tg_table_name
        using errcode = '23514'; -- check_violation
    return null; -- unreachable, satisfies plpgsql control-flow requirement
end;
$$;

create trigger trg_forbid_delete_projects
    before delete on projects
    for each row execute function forbid_physical_delete();

create trigger trg_forbid_delete_transactions
    before delete on transactions
    for each row execute function forbid_physical_delete();

create trigger trg_forbid_delete_commitments
    before delete on commitments
    for each row execute function forbid_physical_delete();

create trigger trg_forbid_delete_audit_events
    before delete on audit_events
    for each row execute function forbid_physical_delete();

create trigger trg_forbid_delete_users
    before delete on users
    for each row execute function forbid_physical_delete();

-- Audit events are strictly append-only: neither DELETE (blocked
-- above) nor UPDATE is permitted once a row is written.
create or replace function forbid_audit_event_update()
returns trigger
language plpgsql
as $$
begin
    raise exception
        'audit_events is strictly append-only; rows cannot be modified after insert (architecturefinal-v4.5.1.md §6 entity 14, "STRICTLY APPEND ONLY").'
        using errcode = '23514'; -- check_violation
    return null; -- unreachable
end;
$$;

create trigger trg_forbid_update_audit_events
    before update on audit_events
    for each row execute function forbid_audit_event_update();
