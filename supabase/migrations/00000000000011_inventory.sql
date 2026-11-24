-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0011: inventory_items, inventory_movements
--
-- Source: architecturefinal-v4.5.1.md §6, entities 19-20.

-- 19. Inventory Items (stock resource master)
create table inventory_items (
    id         uuid primary key not null default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete restrict,
    item_name  text not null,
    unit       text not null, -- KG, LITERS, PIECES, BAGS
    is_active  boolean not null default true
);

-- 20. Inventory Movements (traceable stock movement ledger)
create table inventory_movements (
    id                  uuid primary key not null default gen_random_uuid(),
    inventory_item_id   uuid not null references inventory_items(id) on delete restrict,
    movement_type       text not null, -- ADD, USE, ADJUSTMENT
    quantity_minor      integer not null check (quantity_minor > 0),
    reason              text not null,
    created_by_user_id  uuid not null references users(id) on delete restrict,
    created_at          timestamptz not null
);

create index idx_inventory_item_moves on inventory_movements(inventory_item_id);

comment on table inventory_movements is
    'Simple, traceable stock movement history -- deliberately not a warehouse/stock-accounting system (architecture §17 Inventory requirements).';
