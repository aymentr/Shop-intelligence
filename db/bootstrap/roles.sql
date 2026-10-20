-- B-002 bootstrap, part 1: cluster-wide roles. Idempotent.
-- Run once per PostgreSQL cluster by an operator with CREATEROLE (in tests:
-- the container's bootstrap superuser). Migrations never create roles.
-- Passwords are NOT set here; the bootstrap runner sets them from the
-- environment when provided.

DO $$
DECLARE r text;
BEGIN
  -- Owner of every B-002 object. Cannot log in and has no elevated attributes.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'si_owner') THEN
    CREATE ROLE si_owner NOLOGIN;
  END IF;
  ALTER ROLE si_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;

  FOREACH r IN ARRAY ARRAY['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT', r);
  END LOOP;
END $$;

-- Per-role session limits (frozen design 2.1, "Database roles for B-002").
ALTER ROLE si_collector    SET statement_timeout = '30s';
ALTER ROLE si_collector    SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE si_collector    SET lock_timeout = '30s';
ALTER ROLE si_rights_admin SET lock_timeout = '30s';
ALTER ROLE si_retention    SET lock_timeout = '30s';
ALTER ROLE si_retention    SET statement_timeout = '120s';
ALTER ROLE si_monitor      SET statement_timeout = '30s';
