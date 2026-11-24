-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0012: General Reserve cross-row structural guardrails
--
-- Source: architecturefinal-v4.5.1.md §6 General Reserve Protection
-- Invariant; §13 Invariant 65.
--
-- The two same-row General Reserve rules (GR cannot itself be a
-- clone; GR cannot be CLOSED) were already added as plain CHECK
-- constraints directly on the projects table in migration 0002,
-- because a CHECK constraint can only see columns of the same row.
-- The two remaining rules below are inherently cross-row and require
-- a partial unique index / trigger instead:
--
--   1. "Exactly one project may ever have is_general_reserve = true."
--   2. "The General Reserve project ... can never itself be a clone
--       target [as in: no OTHER project may be cloned FROM it]"
--      -- i.e. cloned_from_project_id may never resolve to a project
--      with is_general_reserve = true.
--
-- Both are explicit architectural requirements (quoted above); no new
-- financial rule is introduced here.

-- (1) At most one General Reserve project can ever exist.
create unique index uidx_projects_single_general_reserve
    on projects ((is_general_reserve))
    where is_general_reserve = true;

-- (2) No project may be cloned FROM the General Reserve.
create or replace function prevent_clone_from_general_reserve()
returns trigger
language plpgsql
as $$
declare
    source_is_general_reserve boolean;
begin
    if new.cloned_from_project_id is not null then
        select is_general_reserve
          into source_is_general_reserve
          from projects
         where id = new.cloned_from_project_id;

        if source_is_general_reserve then
            raise exception
                'General Reserve cannot be used as a Project Clone source (architecturefinal-v4.5.1.md §6 General Reserve Protection Invariant, §16.1).'
                using errcode = '23514'; -- check_violation
        end if;
    end if;

    return new;
end;
$$;

create trigger trg_prevent_clone_from_general_reserve
    before insert or update of cloned_from_project_id on projects
    for each row
    execute function prevent_clone_from_general_reserve();

comment on function prevent_clone_from_general_reserve is
    'Structural enforcement only (Phase 2A). Does not implement the Project Clone Contract''s execution logic (§16) -- that is a later phase.';
