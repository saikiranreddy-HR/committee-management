-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0006: project_deficit_reviews, additional_funding_plans,
--                  funding_plan_items
--
-- Source: architecturefinal-v4.5.1.md §6, entities 9-11; §9.1 for the
-- end-to-end deficit -> funding reconciliation workflow these tables
-- support (execution of that workflow is out of scope for Phase 2A).

-- 9. Project Deficit Reviews (formal review before additional funding)
create table project_deficit_reviews (
    id                          uuid primary key not null default gen_random_uuid(),
    project_id                  uuid not null references projects(id) on delete restrict,
    deficit_amount_minor_units  integer not null check (deficit_amount_minor_units > 0),
    reason                      text not null,
    explanation                 text not null,
    comments                    text,
    reviewed_by_user_id         uuid not null references users(id) on delete restrict,
    reviewed_at                 timestamptz not null,
    approved_by_user_id         uuid references users(id) on delete restrict,
    approved_at                 timestamptz,
    status                      text not null, -- PENDING_APPROVAL, APPROVED, REJECTED

    -- Maker-checker: reviewer cannot approve their own review.
    -- Source: §13 Invariant 37, §12.1 footnote 2.
    constraint chk_deficit_review_maker_checker
        check (approved_by_user_id is null or reviewed_by_user_id != approved_by_user_id)
);

create index idx_deficit_project on project_deficit_reviews(project_id);

-- 10. Additional Funding Plans (planned deficit coverage tracking)
create table additional_funding_plans (
    id                           uuid primary key not null default gen_random_uuid(),
    project_id                   uuid not null references projects(id) on delete restrict,
    deficit_review_id            uuid not null references project_deficit_reviews(id) on delete restrict,
    required_amount_minor_units  integer not null check (required_amount_minor_units > 0),
    status                       text not null -- ACTIVE, RESOLVED, OVERFUNDED
);

create index idx_funding_plan_proj on additional_funding_plans(project_id);

comment on table additional_funding_plans is
    'A funding PLAN is never money and never increases project liquidity on its own (§9.1 points 1-3, §13 Invariant 27/55). Realization happens only through POSTED transactions referencing this plan (transactions.funding_plan_id).';

-- 11. Funding Plan Items (individual planned funding source components)
create table funding_plan_items (
    id                          uuid primary key not null default gen_random_uuid(),
    funding_plan_id             uuid not null references additional_funding_plans(id) on delete cascade,
    source_type                 text not null, -- COMMITTEE_TRANSFER, MEMBER_CONTRIBUTION, PUBLIC_DONATION, OTHER
    planned_amount_minor_units  integer not null check (planned_amount_minor_units > 0),
    notes                       text
);

comment on table funding_plan_items is
    'Non-financial structural sub-entity of additional_funding_plans; ON DELETE CASCADE is permitted here per §6.1 (cascading deletion allowed only on non-financial structural sub-entities).';
