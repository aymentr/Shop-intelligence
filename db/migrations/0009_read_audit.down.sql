-- B-002 migration 0009 down: remove the durable read audit and restore the 0008 read function
-- (si_read_evidence(text, text, int)) byte for byte with its 0008 privileges. Intents and the
-- access-log intent column are dropped (destructive: the migrator requires allowDestructive).

DROP FUNCTION si.si_read_evidence(text, uuid, text, int);
DROP FUNCTION si.si_begin_read(text, text, int);
DROP FUNCTION si.si_read_cursor_digest(text);
ALTER TABLE si.reader_access_log DROP COLUMN intent_id;
DROP TABLE si.read_intents;
DROP FUNCTION si.trg_read_intents_guard();

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

REVOKE ALL ON FUNCTION si.si_read_evidence(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_read_evidence(text, text, int) TO si_reader;
