-- B-002 migration 0008: Milestone 3 part 3C — controlled internal evidence retrieval (synthetic only).
-- Contract: docs/b002-m3-design.md §14.
--
-- One read function for explicitly granted INTERNAL principals; nothing customer-facing. A record is
-- returned only if, at the moment of the read and under the source lock, every one of these holds:
--   - the session's login (session_user) is a dedicated reader principal (si_reader_<name>, LOGIN,
--     member of si_reader, no elevated attribute, no other si_* role) with an active grant for this
--     exact source (si.reader_grants, purpose INTERNAL_SYNTHETIC_EVALUATION);
--   - si_evidence_readable(run) (0007): a VALID receipt verification AND the current authorization —
--     retention, suspension, termination, retirement, current rights, supported networks, SYNTHETIC;
--   - the session cannot write the result to the server log and its statement / idle-in-transaction
--     time is bounded.
-- Internal evaluation access is a separate concept from source-content display rights: the rights
-- model (subscriber_display, export, media_mirror: DENIED/UNKNOWN only) is unchanged and no read here
-- is a customer display. Destination and creative URLs are not returned.
--
-- Lock order: rank 3 only (sources FOR SHARE, like T2) — conflicts with rights changes, source
-- controls, retirement, purge and grant changes, which therefore serialize with each read. The lock is
-- taken inside a sub-block whose subtransaction is rolled back before the function returns, so it is
-- released when the read ends even if the caller keeps its transaction open (PostgreSQL releases locks
-- acquired after a savepoint when it is rolled back to). Waiting for the lock is bounded (lock_timeout).

------------------------------------------------------------------------------------------
-- Reader principals and per-source internal grants
------------------------------------------------------------------------------------------
-- A dedicated reader principal: never a shared service role, never elevated, never another si_* role.
CREATE FUNCTION si.si_reader_principal_ok(p_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((
    SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
       AND NOT r.rolbypassrls
       AND r.rolname ~ '^si_reader_[a-z0-9_]{1,40}$'
       AND pg_catalog.pg_has_role(r.oid, 'si_reader'::regrole, 'MEMBER')
       AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['si_owner', 'si_collector', 'si_rights_admin', 'si_retention', 'si_monitor',
                                                  'si_migrator']) AS s(n)
                        WHERE pg_catalog.pg_has_role(r.oid, s.n::regrole, 'MEMBER'))
      FROM pg_catalog.pg_roles r WHERE r.rolname = p_role), false)
$$;

CREATE TABLE si.reader_grants (
  grant_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal      text NOT NULL CHECK (principal ~ '^si_reader_[a-z0-9_]{1,40}$'),
  source_id      text NOT NULL REFERENCES si.sources (source_id),
  purpose        text NOT NULL CHECK (purpose = 'INTERNAL_SYNTHETIC_EVALUATION'),
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  granted_by     text NOT NULL,
  granted_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_by     text,
  revoke_reason  text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  CONSTRAINT reader_grants_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)
                                             AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT reader_grants_order CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX reader_grants_one_active ON si.reader_grants (principal, source_id) WHERE revoked_at IS NULL;

-- Grants are created and revoked only through the functions below; a revocation is final.
CREATE FUNCTION si.trg_reader_grants_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $reader_grants_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.granted_by := session_user;
    NEW.granted_at := clock_timestamp();
    NEW.revoked_at := NULL; NEW.revoked_by := NULL; NEW.revoke_reason := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND ROW(NEW.grant_id, NEW.principal, NEW.source_id, NEW.purpose, NEW.reason, NEW.granted_by, NEW.granted_at)
         IS NOT DISTINCT FROM ROW(OLD.grant_id, OLD.principal, OLD.source_id, OLD.purpose, OLD.reason, OLD.granted_by, OLD.granted_at) THEN
    NEW.revoked_at := clock_timestamp();
    NEW.revoked_by := session_user;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SI_READER_GRANT_IMMUTABLE: reader grants can only be revoked, once' USING ERRCODE = '23514';
END $reader_grants_guard$;

CREATE TRIGGER trg_reader_grants_guard BEFORE INSERT OR UPDATE OR DELETE ON si.reader_grants
FOR EACH ROW EXECUTE FUNCTION si.trg_reader_grants_guard();
CREATE TRIGGER trg_reader_grants_no_truncate BEFORE TRUNCATE ON si.reader_grants
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_reader_grants_guard();

-- Grant and revocation lock the source row FOR UPDATE (rank 3): they wait for any read in progress
-- and every later read sees them.
CREATE FUNCTION si.si_grant_reader(p_principal text, p_source_id text, p_reason text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $grant_reader$
DECLARE
  s record;
  id bigint;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: reader grants require READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: a reason of 1 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.source_id, x.evidence_kind, x.retired_at INTO s FROM si.sources x WHERE x.source_id = p_source_id FOR UPDATE;   -- rank 3
  IF s.source_id IS NULL OR s.evidence_kind <> 'SYNTHETIC' OR (s.retired_at IS NOT NULL AND s.retired_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'SI_READER_GRANT_REFUSED: the source cannot be granted' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT si.si_reader_principal_ok(p_principal) THEN
    RAISE EXCEPTION 'SI_READER_GRANT_REFUSED: not a dedicated reader principal' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO si.reader_grants (principal, source_id, purpose, reason, granted_by, granted_at)
  VALUES (p_principal, p_source_id, 'INTERNAL_SYNTHETIC_EVALUATION', btrim(p_reason), session_user, clock_timestamp())
  RETURNING grant_id INTO id;
  RETURN id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'SI_READER_GRANT_EXISTS: an active grant already exists' USING ERRCODE = 'check_violation';
END $grant_reader$;

CREATE FUNCTION si.si_revoke_reader(p_principal text, p_source_id text, p_reason text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $revoke_reader$
DECLARE
  id bigint;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: reader grants require READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: a reason of 1 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id FOR UPDATE;                                -- rank 3
  UPDATE si.reader_grants g SET revoked_at = clock_timestamp(), revoked_by = session_user, revoke_reason = btrim(p_reason)
   WHERE g.principal = p_principal AND g.source_id = p_source_id AND g.revoked_at IS NULL
  RETURNING g.grant_id INTO id;
  IF id IS NULL THEN
    RAISE EXCEPTION 'SI_READER_GRANT_NOT_FOUND: no active grant' USING ERRCODE = 'check_violation';
  END IF;
  RETURN id;
END $revoke_reader$;

------------------------------------------------------------------------------------------
-- Session safety for readers (effective values in the calling session).
------------------------------------------------------------------------------------------
-- NULL when safe, otherwise the name of the first unsafe setting (a setting name, never content).
CREATE FUNCTION si.si_reader_session_problem() RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN current_setting('log_statement') NOT IN ('none', 'ddl') THEN 'log_statement'
    WHEN current_setting('log_min_duration_statement') <> '-1' THEN 'log_min_duration_statement'
    WHEN current_setting('log_min_duration_sample') <> '-1' THEN 'log_min_duration_sample'
    WHEN current_setting('log_transaction_sample_rate')::float8 <> 0 THEN 'log_transaction_sample_rate'
    WHEN current_setting('log_parameter_max_length') <> '0' THEN 'log_parameter_max_length'
    WHEN current_setting('log_parameter_max_length_on_error') <> '0' THEN 'log_parameter_max_length_on_error'
    WHEN current_setting('statement_timeout')::interval NOT BETWEEN interval '1 millisecond' AND interval '10 seconds'
      THEN 'statement_timeout'
    WHEN current_setting('idle_in_transaction_session_timeout')::interval NOT BETWEEN interval '1 millisecond' AND interval '10 seconds'
      THEN 'idle_in_transaction_session_timeout'
  END
$$;

------------------------------------------------------------------------------------------
-- Content-free access audit (successful reads; refused reads raise and leave nothing behind).
------------------------------------------------------------------------------------------
CREATE TABLE si.reader_access_log (
  access_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal       text NOT NULL CHECK (principal ~ '^si_reader_[a-z0-9_]{1,40}$'),
  source_id       text NOT NULL,
  rows_returned   int NOT NULL CHECK (rows_returned BETWEEN 0 AND 100),
  bytes_returned  int NOT NULL CHECK (bytes_returned BETWEEN 0 AND 262144),
  accessed_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION si.trg_reader_access_log_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $reader_access_guard$
BEGIN
  RAISE EXCEPTION 'SI_READER_LOG_IMMUTABLE: access records cannot be changed or removed' USING ERRCODE = '23514';
END $reader_access_guard$;
CREATE TRIGGER trg_reader_access_log_append_only BEFORE UPDATE OR DELETE ON si.reader_access_log
FOR EACH ROW EXECUTE FUNCTION si.trg_reader_access_log_append_only();
CREATE TRIGGER trg_reader_access_log_no_truncate BEFORE TRUNCATE ON si.reader_access_log
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_reader_access_log_append_only();

------------------------------------------------------------------------------------------
-- The read function.
------------------------------------------------------------------------------------------
-- Exactly the permitted fields. Not returned: destination_url, creative_url (and nothing else).
CREATE TYPE si.evidence_read_row AS (
  run_id                      uuid,
  ordinal                     int,
  collected_at                timestamptz,
  network                     text,
  native_ad_id                text,
  advertiser_name             text,
  countries                   text[],
  seen_at                     timestamptz,
  source_url                  text,
  title                       text,
  source_reported_first_seen  timestamptz,
  source_reported_last_seen   timestamptz,
  content_sha256              text,
  next_cursor                 text
);

-- si_read_evidence(source, cursor, limit): at most 100 records and 262,144 bytes (JSON text of each
-- record) per call, in (collected_at, run_id, ordinal) order. next_cursor of the last record resumes
-- after it; a cursor names its source and is never a capability (authorization is re-checked).
-- Fixed errors: SI_READ_NOT_AUTHORIZED (42501; also for an unknown source), SI_READ_BAD_ARGUMENT,
-- SI_READ_BAD_CURSOR (22023), SI_READ_UNSAFE_SESSION (55000), SI_READ_BUSY (55P03), SI_ISOLATION.
CREATE FUNCTION si.si_read_evidence(p_source_id text, p_cursor text DEFAULT NULL, p_limit int DEFAULT 50)
RETURNS SETOF si.evidence_read_row
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $read_evidence$
DECLARE
  who text := session_user;
  problem text;
  m text[];
  c_fin timestamptz;
  c_run uuid;
  c_ord int;
  rec record;
  one si.evidence_read_row;
  out_rows si.evidence_read_row[] := '{}';
  bytes int := 0;
  sz int;
  cap constant int := 262144;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: reads require READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: limit must be between 1 and 100' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Identity first: a session that is not a dedicated reader learns nothing else (not even session policy).
  IF p_source_id IS NULL OR p_source_id !~ '^[a-z0-9][a-z0-9-]{1,62}$' OR NOT si.si_reader_principal_ok(who) THEN
    RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  problem := si.si_reader_session_problem();
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'SI_READ_UNSAFE_SESSION: %', problem USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_cursor IS NOT NULL THEN
    m := CASE WHEN length(p_cursor) <= 160 THEN regexp_match(p_cursor,
           '^v1\|([a-z0-9][a-z0-9-]{1,62})\|([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([0-9]{1,3})$') END;
    IF m IS NULL OR m[1] IS DISTINCT FROM p_source_id OR m[4]::int > 499 THEN
      RAISE EXCEPTION 'SI_READ_BAD_CURSOR: malformed or foreign cursor' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    BEGIN
      c_fin := m[2]::timestamptz; c_run := m[3]::uuid; c_ord := m[4]::int;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'SI_READ_BAD_CURSOR: malformed or foreign cursor' USING ERRCODE = 'invalid_parameter_value';
    END;
  END IF;

  BEGIN
    -- rank 3; a new statement afterwards sees every change committed before the lock was granted
    PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR SHARE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g
                                 WHERE g.principal = who AND g.source_id = p_source_id AND g.revoked_at IS NULL
                                   AND g.purpose = 'INTERNAL_SYNTHETIC_EVALUATION') THEN
      RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR rec IN
      WITH runs AS (
        SELECT r.run_id, r.finished_at
          FROM si.collection_runs r
         WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
           AND (c_run IS NULL OR (r.finished_at, r.run_id) >= (c_fin, c_run))
           AND si.si_evidence_readable(r.run_id)
         ORDER BY r.finished_at, r.run_id
         LIMIT p_limit + 1)
      SELECT runs.run_id, o.ordinal, runs.finished_at, o.network, o.native_ad_id, o.advertiser_name, o.countries, o.seen_at,
             o.source_url, o.title, o.source_reported_first_seen, o.source_reported_last_seen, o.content_sha256
        FROM runs JOIN si.observations o ON o.run_id = runs.run_id
       WHERE c_run IS NULL OR (runs.finished_at, runs.run_id, o.ordinal) > (c_fin, c_run, c_ord)
       ORDER BY runs.finished_at, runs.run_id, o.ordinal
       LIMIT p_limit
    LOOP
      one := ROW(rec.run_id, rec.ordinal, rec.finished_at, rec.network, rec.native_ad_id, rec.advertiser_name, rec.countries,
                 rec.seen_at, rec.source_url, rec.title, rec.source_reported_first_seen, rec.source_reported_last_seen,
                 rec.content_sha256,
                 'v1|' || p_source_id || '|' || to_char(rec.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   || '|' || rec.run_id::text || '|' || rec.ordinal::text)::si.evidence_read_row;
      sz := octet_length(row_to_json(one)::text);
      EXIT WHEN bytes + sz > cap;
      bytes := bytes + sz;
      out_rows := out_rows || one;
    END LOOP;
    -- Roll back this sub-block: its subtransaction, and with it the source lock, ends here.
    RAISE EXCEPTION USING ERRCODE = 'SIRLS', MESSAGE = 'SI_READ_RELEASE';
  EXCEPTION
    WHEN SQLSTATE 'SIRLS' THEN NULL;
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'SI_READ_BUSY: the source is being changed; retry' USING ERRCODE = 'lock_not_available';
  END;

  INSERT INTO si.reader_access_log (principal, source_id, rows_returned, bytes_returned)
  VALUES (who, p_source_id, cardinality(out_rows), bytes);
  RETURN QUERY SELECT * FROM unnest(out_rows);
END $read_evidence$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC. si_reader: EXECUTE on the read function only (no table, no
-- evidence, no rights, collection, verification or purge privilege). Grants are managed by
-- si_rights_admin; grants and the access log are visible (content-free) to si_rights_admin / si_monitor.
------------------------------------------------------------------------------------------
REVOKE ALL ON si.reader_grants, si.reader_access_log FROM PUBLIC;
REVOKE ALL ON TYPE si.evidence_read_row FROM PUBLIC;
GRANT USAGE ON TYPE si.evidence_read_row TO si_reader;
GRANT SELECT ON si.reader_grants TO si_rights_admin, si_monitor;
GRANT SELECT ON si.reader_access_log TO si_monitor;
REVOKE ALL ON FUNCTION
  si.si_reader_principal_ok(text), si.trg_reader_grants_guard(), si.si_grant_reader(text, text, text),
  si.si_revoke_reader(text, text, text), si.si_reader_session_problem(), si.trg_reader_access_log_append_only(),
  si.si_read_evidence(text, text, int)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_grant_reader(text, text, text), si.si_revoke_reader(text, text, text) TO si_rights_admin;
GRANT EXECUTE ON FUNCTION si.si_read_evidence(text, text, int) TO si_reader;
