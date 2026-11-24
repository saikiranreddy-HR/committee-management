-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0005: food_sessions
--
-- Source: architecturefinal-v4.5.1.md §6, entity 8.

-- 8. Food Sessions (Annadanam session records)
create table food_sessions (
    id            uuid primary key not null default gen_random_uuid(),
    project_id    uuid not null references projects(id) on delete restrict,
    session_date  timestamptz not null,
    meal_type     text not null, -- BREAKFAST, LUNCH, DINNER, SPECIAL_PRASADAM
    people_served integer not null check (people_served >= 0),
    notes         text
);

create index idx_food_project on food_sessions(project_id);
