-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0010: pooja_configs, pooja_days, pooja_slots, pooja_participants
--
-- Source: architecturefinal-v4.5.1.md §6, entities 15-18.
--
-- JSON columns use `jsonb` (idiomatic PostgreSQL type), per §6's
-- dialect note. ON DELETE CASCADE from pooja_configs -> pooja_days ->
-- pooja_slots -> pooja_participants is explicitly permitted by §6.1
-- ("cascading deletion is permitted only on non-financial structural
-- sub-entities"), matching §6.1's own example.

-- 15. Pooja Configs (multi-day schedule root)
create table pooja_configs (
    id                            uuid primary key not null default gen_random_uuid(),
    project_id                    uuid unique not null references projects(id) on delete restrict,
    total_days                    integer not null check (total_days > 0),
    default_morning_time          text not null,
    default_evening_time          text not null,
    default_expected_items_json   jsonb not null
);

-- 16. Pooja Days (calendar days within a festival)
create table pooja_days (
    id              uuid primary key not null default gen_random_uuid(),
    pooja_config_id uuid not null references pooja_configs(id) on delete cascade,
    day_number      integer not null check (day_number > 0),
    date            timestamptz not null,
    unique (pooja_config_id, day_number)
);

create index idx_pooja_days_config on pooja_days(pooja_config_id);

-- 17. Pooja Slots (morning & evening time blocks)
create table pooja_slots (
    id                      uuid primary key not null default gen_random_uuid(),
    pooja_day_id            uuid not null references pooja_days(id) on delete cascade,
    slot_type               text not null, -- MORNING, EVENING
    start_time              text not null,
    end_time                text not null,
    committee_will_arrange  boolean not null default false,
    unique (pooja_day_id, slot_type)
);

-- 18. Pooja Participants (devotee slot assignments)
create table pooja_participants (
    id                          uuid primary key not null default gen_random_uuid(),
    pooja_slot_id               uuid not null references pooja_slots(id) on delete cascade,
    participant_user_id         uuid references users(id) on delete set null,
    participant_name_snapshot   text not null,
    phone_number                text,
    prasadam_promise            text,
    item_responsibilities_json  jsonb,
    is_committee_arranged       boolean not null default false
);

create index idx_pooja_part_slot on pooja_participants(pooja_slot_id);

comment on table pooja_slots is
    'Multiple participants may be assigned to the same slot; overlap is a UI-level warning, not a database-level block (architecture §16 Pooja requirements). No uniqueness constraint on (pooja_slot_id, participant_user_id) is added for this reason.';
