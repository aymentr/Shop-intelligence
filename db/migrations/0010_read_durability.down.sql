-- B-002 migration 0010 down: restore the 0009 intent trigger and read function byte for byte (CREATE OR
-- REPLACE keeps their owners and ACLs). Intents created under 0010 stay as rows; after down their ids no
-- longer matter (0009 looks intents up by id only).

CREATE OR REPLACE FUNCTION si.trg_read_intents_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $read_intents_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.intent_id := gen_random_uuid();
    NEW.principal := session_user;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '60 seconds';
    NEW.created_xid := pg_current_xact_id();
    NEW.state := 'OPEN';
    NEW.consumed_at := NULL; NEW.rows_returned := NULL; NEW.bytes_returned := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'OPEN' AND NEW.state = 'CONSUMED'
     AND ROW(NEW.intent_id, NEW.principal, NEW.source_id, NEW.cursor_sha256, NEW.read_limit, NEW.created_at, NEW.expires_at, NEW.created_xid)
         IS NOT DISTINCT FROM ROW(OLD.intent_id, OLD.principal, OLD.source_id, OLD.cursor_sha256, OLD.read_limit, OLD.created_at, OLD.expires_at, OLD.created_xid) THEN
    NEW.consumed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SI_READ_INTENT_IMMUTABLE: read intents can only be consumed, once' USING ERRCODE = '23514';
END $read_intents_guard$;

CREATE OR REPLACE FUNCTION si.si_read_evidence(p_source_id text, p_intent_id uuid, p_cursor text DEFAULT NULL, p_limit int DEFAULT 50)
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
  it record;
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

  -- The committed audit record must exist before anything is decided about evidence.
  SELECT i.principal, i.source_id, i.cursor_sha256, i.read_limit, i.state, i.expires_at, i.created_xid INTO it
    FROM si.read_intents i WHERE i.intent_id = p_intent_id;
  IF it.principal IS NULL OR it.principal IS DISTINCT FROM who OR it.source_id IS DISTINCT FROM p_source_id
     OR it.read_limit IS DISTINCT FROM p_limit OR it.cursor_sha256 IS DISTINCT FROM si.si_read_cursor_digest(p_cursor) THEN
    RAISE EXCEPTION 'SI_READ_INTENT_INVALID: no matching read intent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_xact_status(it.created_xid) IS DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'SI_READ_INTENT_UNCOMMITTED: the read intent must be committed first' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF it.state <> 'OPEN' THEN
    RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF it.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'SI_READ_INTENT_EXPIRED: the read intent expired' USING ERRCODE = 'object_not_in_prerequisite_state';
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

  -- Consume the intent (no other lock is held now). A concurrent read of the same intent waits here
  -- and then finds it CONSUMED; if that read's transaction rolls back, this one may consume it.
  BEGIN
    UPDATE si.read_intents i SET state = 'CONSUMED', rows_returned = cardinality(out_rows), bytes_returned = bytes
     WHERE i.intent_id = p_intent_id AND i.state = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SI_READ_BUSY: the read intent is in use; retry' USING ERRCODE = 'lock_not_available';
  END;
  INSERT INTO si.reader_access_log (principal, source_id, rows_returned, bytes_returned, intent_id)
  VALUES (who, p_source_id, cardinality(out_rows), bytes, p_intent_id);
  RETURN QUERY SELECT * FROM unnest(out_rows);
END $read_evidence$;
