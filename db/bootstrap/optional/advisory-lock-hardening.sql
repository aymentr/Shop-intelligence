-- D5b advisory-lock hardening. Separate mandatory production operator step (founder decision b).
-- (docs/b002-m2-plan.md section 7). Tested by tests/db/migrator.test.mjs in a throwaway database.
--
-- Effect: no role except si_migrator (migration lock, bigint form) and si_owner (request-key
-- lock inside si_begin_run / trg_runs_insert, two-int form) may take or release advisory
-- locks. Superusers are unaffected. Must run in EVERY database (pg_proc ACLs are per database;
-- a database created from template0 starts with PostgreSQL's defaults again).
--
-- Requires the OWNER of the pg_catalog functions (the cluster's bootstrap superuser). A
-- non-owner REVOKE only emits "WARNING: no privileges could be revoked" and leaves PUBLIC
-- EXECUTE in place, so the block at the end verifies the result and fails loudly.
BEGIN;

REVOKE EXECUTE ON FUNCTION
  pg_catalog.pg_advisory_lock(bigint), pg_catalog.pg_advisory_lock(integer, integer),
  pg_catalog.pg_advisory_lock_shared(bigint), pg_catalog.pg_advisory_lock_shared(integer, integer),
  pg_catalog.pg_try_advisory_lock(bigint), pg_catalog.pg_try_advisory_lock(integer, integer),
  pg_catalog.pg_try_advisory_lock_shared(bigint), pg_catalog.pg_try_advisory_lock_shared(integer, integer),
  pg_catalog.pg_advisory_unlock(bigint), pg_catalog.pg_advisory_unlock(integer, integer),
  pg_catalog.pg_advisory_unlock_shared(bigint), pg_catalog.pg_advisory_unlock_shared(integer, integer),
  pg_catalog.pg_advisory_unlock_all(),
  pg_catalog.pg_advisory_xact_lock(bigint), pg_catalog.pg_advisory_xact_lock(integer, integer),
  pg_catalog.pg_advisory_xact_lock_shared(bigint), pg_catalog.pg_advisory_xact_lock_shared(integer, integer),
  pg_catalog.pg_try_advisory_xact_lock(bigint), pg_catalog.pg_try_advisory_xact_lock(integer, integer),
  pg_catalog.pg_try_advisory_xact_lock_shared(bigint), pg_catalog.pg_try_advisory_xact_lock_shared(integer, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) TO si_migrator;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(integer, integer) TO si_owner;

DO $
DECLARE still text;
DECLARE exposed text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO still
  FROM pg_catalog.pg_proc p
  WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory'
    AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF still IS NOT NULL THEN
    RAISE EXCEPTION 'SI_HARDENING_INCOMPLETE: PUBLIC can still execute %; run as the owner of pg_catalog', still;
  END IF;
  -- Check effective access, not only PUBLIC ACLs: an explicit grant or inherited
  -- membership could otherwise leave a runtime role able to acquire advisory locks.
  SELECT string_agg(role_name || ':' || function_name, ', ') INTO exposed
  FROM (
    SELECT r.rolname AS role_name, p.oid::regprocedure::text AS function_name
    FROM pg_catalog.pg_roles r
    CROSS JOIN pg_catalog.pg_proc p
    WHERE r.rolname IN ('si_collector','si_rights_admin','si_retention','si_monitor')
      AND p.pronamespace = 'pg_catalog'::regnamespace
      AND p.proname ~ '^pg_(try_)?advisory'
      AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
  ) violations;
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION 'SI_HARDENING_INCOMPLETE: application role advisory-lock access: %', exposed;
  END IF;
END $$;

COMMIT;
