-- B-002 bootstrap, part 2: per-database setup. Idempotent.
-- Run in every database that will hold B-002 objects (and again in each
-- database cloned from a template, because database-level ACLs are not copied).
-- Requires a role that can create schemas and alter default privileges
-- (in tests: the bootstrap superuser).

-- Nobody but explicitly granted roles may connect or create temporary objects.
-- Revoking TEMP removes pg_temp shadowing as an attack surface entirely.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO si_collector, si_rights_admin, si_retention, si_monitor',
                 current_database());
END $$;

-- The public schema is not used by B-002 and nobody may create objects in it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- All B-002 objects live in schema si, owned by si_owner.
CREATE SCHEMA IF NOT EXISTS si AUTHORIZATION si_owner;
ALTER SCHEMA si OWNER TO si_owner;
REVOKE ALL ON SCHEMA si FROM PUBLIC;
GRANT USAGE ON SCHEMA si TO si_collector, si_rights_admin, si_retention, si_monitor;

-- Functions start closed: PostgreSQL grants EXECUTE to PUBLIC by default.
-- DEVIATION from the frozen text of Amendment A4, which says
--   ALTER DEFAULT PRIVILEGES FOR ROLE si_owner IN SCHEMA si REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
-- In PostgreSQL, per-schema default privileges can only ADD to the global defaults,
-- so that statement is accepted but has no effect (verified by test SD5). The
-- role-wide form below achieves the design's intent: every function si_owner creates
-- in this database starts without PUBLIC EXECUTE. Default ACLs are per database.
ALTER DEFAULT PRIVILEGES FOR ROLE si_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
