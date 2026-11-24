-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0002: projects
--
-- Source: architecturefinal-v4.5.1.md §6, entity 3 ("Projects").
--
-- This migration creates the projects table structure only. The
-- General Reserve *protection* rules that reference other rows (e.g.
-- "exactly one General Reserve", "General Reserve cannot be a clone
-- source/target") require either a partial unique index or a trigger
-- and are added later in migration 0012
-- (general_reserve_guardrails.sql), once the table exists. The two
-- General Reserve rules that are expressible as a same-row CHECK are
-- added directly on this table below, since they need no other
-- migration to exist first.

create table projects (
    id                      uuid primary key not null default gen_random_uuid(),
    name                    text not null,
    type                    text not null, -- FESTIVAL, RELIGIOUS_ACTIVITY, TEMPLE_DONATION, VILLAGE_PROGRAM, ANNADANAM, GENERAL_RESERVE, OTHER
    start_date              timestamptz not null,
    end_date                timestamptz not null,
    status                  text not null, -- PLANNING, ACTIVE, RECONCILIATION_REVIEW, COMPLETED, CLOSED
    is_general_reserve      boolean not null default false, -- Protected root project flag
    cloned_from_project_id  uuid references projects(id) on delete set null,
    current_version         integer not null default 1,
    is_deleted              boolean not null default false,
    client_timestamp        timestamptz not null,
    server_timestamp        timestamptz,

    -- General Reserve cannot itself be a clone (same-row check; the
    -- cross-row "GR cannot be a clone SOURCE" and "at most one GR"
    -- rules need a trigger/partial index and are added in migration
    -- 0012). Source: §6 General Reserve Protection Invariant.
    constraint chk_general_reserve_not_a_clone
        check (not (is_general_reserve and cloned_from_project_id is not null)),

    -- General Reserve cannot be closed (same-row check).
    -- Source: §6 General Reserve Protection Invariant; §17.2 point 16.
    constraint chk_general_reserve_not_closed
        check (not (is_general_reserve and status = 'CLOSED'))
);

create index idx_projects_status on projects(status);

comment on table projects is
    'Festival/ritual containers, including the single protected General Reserve root project (architecturefinal-v4.5.1.md §6, §16, §17).';
comment on column projects.cloned_from_project_id is
    'Configuration-lineage pointer only. Carries no financial meaning and creates no financial relationship between source and destination (§6, §16.5).';
