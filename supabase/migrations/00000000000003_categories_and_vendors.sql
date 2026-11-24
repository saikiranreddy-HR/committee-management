-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0003: project_categories, vendors
--
-- Source: architecturefinal-v4.5.1.md §6, entities 4-5.

-- 4. Project Categories (project-specific cost & income categories)
create table project_categories (
    id            uuid primary key not null default gen_random_uuid(),
    project_id    uuid not null references projects(id) on delete restrict,
    name          text not null,
    category_type text not null, -- EXPENSE, INCOME
    sort_order    integer not null default 0,
    is_active     boolean not null default true
);

create index idx_categories_project on project_categories(project_id);

-- 5. Vendors (minimal master data for multi-year cost tracking)
create table vendors (
    id               uuid primary key not null default gen_random_uuid(),
    name             text not null,
    phone            text,
    service_category text not null,
    notes            text,
    is_active        boolean not null default true
);

comment on table vendors is
    'Minimal vendor master data, reused (never duplicated) across projects and clones (§6, §16.2 point 4).';
