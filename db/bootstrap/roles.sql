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

  -- Milestone 3 (M3-P3C): group of dedicated internal reader principals (si_reader_<name> logins).
  -- It cannot log in; its members inherit EXECUTE on the read function only.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'si_reader') THEN
    CREATE ROLE si_reader NOLOGIN;
  END IF;
  ALTER ROLE si_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;

  FOREACH r IN ARRAY ARRAY['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor', 'si_migrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT', r);
  END LOOP;
END $$;

-- Dedicated non-superuser migrator (M2 step 2, D5b audit). It may only SET ROLE si_owner
-- inside the runner's transaction (SET option); it does NOT inherit si_owner's privileges
-- (INHERIT FALSE + NOINHERIT) and cannot grant the membership onward (no ADMIN option).
-- Operator role: never used by the application. Bootstrap itself stays an administrator
-- task (it creates roles and changes database ACLs).
GRANT si_owner TO si_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

-- Normalize: si_migrator is the ONLY member of si_owner, through exactly one grant. A stray
-- membership (for example an application role) would let that role SET ROLE si_owner and
-- bypass every owner-only boundary, so bootstrap removes it on every run. PostgreSQL 16
-- records one grant per grantor, so each is revoked with its own GRANTED BY.
DO $$
DECLARE g record;
BEGIN
  -- One grant at a time, re-queried after each REVOKE: CASCADE also removes grants that depended
  -- on a revoked ADMIN option, so a precomputed list could name grants that no longer exist.
  LOOP
    SELECT pg_catalog.pg_get_userbyid(m.member) AS member, pg_catalog.pg_get_userbyid(m.grantor) AS grantor INTO g
    FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = 'si_owner'::regrole
      AND (m.member <> 'si_migrator'::regrole OR m.grantor <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
    ORDER BY m.admin_option DESC, m.oid
    LIMIT 1;
    EXIT WHEN NOT FOUND;
    EXECUTE format('REVOKE si_owner FROM %I GRANTED BY %I CASCADE', g.member, g.grantor);
  END LOOP;
END $$;

-- Per-role session limits (frozen design 2.1, "Database roles for B-002").
ALTER ROLE si_collector    SET statement_timeout = '30s';
ALTER ROLE si_collector    SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE si_collector    SET lock_timeout = '30s';
-- Milestone 3 (M3-P2B): the collector transmits evidence payloads as bind parameters. The server
-- must never write them to its log, whatever statement, duration or error logging is enabled.
-- Superuser-only settings: bootstrap runs as an administrator. D7 (`preflight --collector`) and
-- the library verify the effective values in a real collector session before any payload is sent.
ALTER ROLE si_collector    SET log_parameter_max_length = 0;
ALTER ROLE si_collector    SET log_parameter_max_length_on_error = 0;
ALTER ROLE si_rights_admin SET lock_timeout = '30s';
-- Amendment C rev1 R5: bounds how long a control can sit between its decision instant
-- (occurred_at) and its commit while holding the source-row lock.
ALTER ROLE si_rights_admin SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE si_retention    SET lock_timeout = '30s';
ALTER ROLE si_retention    SET statement_timeout = '120s';
ALTER ROLE si_monitor      SET statement_timeout = '30s';
ALTER ROLE si_migrator     SET lock_timeout = '30s';

-- Normalize si_reader membership (M3-P3C): only dedicated reader principals (si_reader_<name>
-- logins) may be members, never a service role. Any other membership is removed on every run.
DO $$
DECLARE g record;
BEGIN
  LOOP
    SELECT pg_catalog.pg_get_userbyid(m.member) AS member, pg_catalog.pg_get_userbyid(m.grantor) AS grantor INTO g
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE m.roleid = 'si_reader'::regrole AND NOT (r.rolname ~ '^si_reader_[a-z0-9_]{1,40}$' AND r.rolcanlogin)
    ORDER BY m.admin_option DESC, m.oid
    LIMIT 1;
    IF NOT FOUND THEN EXIT; END IF;   -- spelled differently from the si_owner loop (mutation anchor)
    EXECUTE format('REVOKE si_reader FROM %I GRANTED BY %I CASCADE', g.member, g.grantor);
  END LOOP;
END $$;
