-- Phase 2D -- Supabase Auth + RBAC + RLS / Authorization Boundary
-- Migration 0018: role helper functions
--
-- Source: architecturefinal-v4.5.1.md §12.1 (Fixed Four-Role Access
-- Model), §12.3 (Multi-Role Users), §6 Account Provisioning Rule.
--
-- These functions are the single place that answers "what role(s)
-- does the current authenticated user hold?" for every RLS policy in
-- this and later migrations -- no policy duplicates this logic.
--
-- `auth.uid()`/`auth.role()` are provided by Supabase itself in a
-- real project (this migration does not define them -- see
-- supabase/tests/helpers/apply-migrations.ts for how the local test
-- harness recreates their externally-observable behavior).

-- Returns the current authenticated user's application identity, or
-- NULL if there is no authenticated session. This is a thin,
-- readable alias for auth.uid() -- introduced so that every policy
-- below reads "app_current_user_id()" rather than a bare
-- "auth.uid()", making it trivial to grep for every place identity is
-- checked.
create or replace function app_current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = public, auth
as $$
    select auth.uid();
$$;

comment on function app_current_user_id is
    'Alias for auth.uid() -- the authenticated Supabase identity, or NULL if unauthenticated (§6 Account Provisioning Rule point 5).';

-- Returns true if the current authenticated user holds the given
-- role. Exactly the four fixed roles are meaningful here (§12.1) --
-- this function does not validate the role name itself (that remains
-- a deliberate non-CHECK-constraint decision per §6.2); it simply
-- reports whether a user_roles row exists.
create or replace function app_has_role(p_role text)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
    select exists (
        select 1
          from user_roles
         where user_id = app_current_user_id()
           and role = p_role
    );
$$;

comment on function app_has_role is
    'True if the authenticated user holds the given role. A user may hold multiple roles simultaneously (§12.3); this checks membership in one specific role, not exclusivity.';

-- Convenience wrapper: true if the authenticated user holds ANY of
-- the given roles (used by policies that grant access to more than
-- one role, e.g. "ACCOUNTANT or ADMIN may manage commitments").
create or replace function app_has_any_role(p_roles text[])
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
    select exists (
        select 1
          from user_roles
         where user_id = app_current_user_id()
           and role = any (p_roles)
    );
$$;

comment on function app_has_any_role is
    'True if the authenticated user holds at least one of the given roles.';

-- SECURITY NOTE (privilege escalation / role-mutation safety, §12.1,
-- "Role Mutation Safety"): these functions are STABLE, SECURITY
-- INVOKER (they run with the calling session's own privileges, not
-- an owner's), and read only `user_roles` via the same RLS-governed
-- table every other query goes through. They grant no privilege by
-- themselves -- they only answer a question. Whether a user CAN see
-- their own (or anyone's) `user_roles` rows, and whether they can
-- ever INSERT/UPDATE/DELETE a `user_roles` row, is governed entirely
-- by the RLS policies on `user_roles` itself (migration 0019) -- not
-- by these helper functions. This keeps "can I check a role" and
-- "can I change a role" as two independently-enforced concerns.
grant execute on function app_current_user_id to authenticated;
grant execute on function app_has_role(text) to authenticated;
grant execute on function app_has_any_role(text[]) to authenticated;
