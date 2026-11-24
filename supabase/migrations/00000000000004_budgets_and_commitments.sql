-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0004: budgets, commitments
--
-- Source: architecturefinal-v4.5.1.md §6, entities 6-7.
--
-- Monetary columns are integer minor units (paise) throughout, never
-- floating point, per §6/§8 and the task's explicit requirement.

-- 6. Budgets (category planned ceilings)
create table budgets (
    id                           uuid primary key not null default gen_random_uuid(),
    project_id                   uuid not null references projects(id) on delete restrict,
    category_id                  uuid not null references project_categories(id) on delete restrict,
    allocated_amount_minor_units integer not null check (allocated_amount_minor_units > 0),
    current_version              integer not null default 1,
    unique (project_id, category_id)
);

create index idx_budgets_project on budgets(project_id);

-- 7. Commitments (inflow pledges & vendor outflow obligations)
create table commitments (
    id                            uuid primary key not null default gen_random_uuid(),
    project_id                    uuid not null references projects(id) on delete restrict,
    category_id                   uuid not null references project_categories(id) on delete restrict,
    vendor_id                     uuid references vendors(id) on delete restrict,
    direction                     text not null, -- INFLOW, OUTFLOW
    party_name                    text not null,
    description                   text,
    committed_amount_minor_units  integer not null check (committed_amount_minor_units > 0),
    is_cancelled                  boolean not null default false,
    cancelled_reason              text,
    current_version               integer not null default 1,
    is_deleted                    boolean not null default false,

    constraint chk_commitment_cancel_reason
        check (is_cancelled = false or cancelled_reason is not null)
);

create index idx_commitments_proj on commitments(project_id, is_cancelled);

comment on table commitments is
    'Inflow pledges (e.g. auction promises) and vendor outflow obligations. Direction/project validation against transaction_type is enforced by the Financial RPC layer, not here (§8.3 Commitment Direction & Project Validation) -- Phase 2A does not implement that engine.';
