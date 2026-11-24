-- Phase 2A -- PostgreSQL Database Foundation
-- Migration 0014: Row Level Security -- default-deny posture only
--
-- Source: architecturefinal-v4.5.1.md §4.5 ("RLS answers: is this
-- user allowed to access this data?"), §4.6 (database defense in
-- depth), and the Phase 2A task instruction: "Do NOT implement ...
-- RLS policies beyond anything absolutely required merely to
-- establish the schema."
--
-- This migration enables Row Level Security on every table and adds
-- ZERO policies. In PostgreSQL/PostgREST semantics, a table with RLS
-- enabled and no policies denies ALL access via the API (to both the
-- anon and authenticated roles) -- it is the safest possible default,
-- not a business-logic decision. Enabling RLS itself is therefore
-- "absolutely required merely to establish the schema" safely: if
-- these tables were exposed via Supabase's PostgREST API with RLS
-- left disabled, they would be fully readable/writable by anyone with
-- the public anon key, which is a severe security gap even at
-- schema-only stage.
--
-- Actual authorization POLICIES (who may read/write which rows under
-- which role) are explicitly deferred to a later phase, alongside the
-- Financial RPC layer they depend on (§4.5, §12.1's four-role
-- capability matrix). Do not add policies to this file.

alter table users                       enable row level security;
alter table user_roles                  enable row level security;
alter table projects                    enable row level security;
alter table project_categories          enable row level security;
alter table vendors                     enable row level security;
alter table budgets                     enable row level security;
alter table commitments                 enable row level security;
alter table food_sessions               enable row level security;
alter table project_deficit_reviews     enable row level security;
alter table additional_funding_plans    enable row level security;
alter table funding_plan_items          enable row level security;
alter table transactions                enable row level security;
alter table attachment_metadata         enable row level security;
alter table audit_events                enable row level security;
alter table pooja_configs               enable row level security;
alter table pooja_days                  enable row level security;
alter table pooja_slots                 enable row level security;
alter table pooja_participants          enable row level security;
alter table inventory_items             enable row level security;
alter table inventory_movements         enable row level security;
