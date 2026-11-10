-- Reverses 0004: restores the Milestone 2 counts-based T2 exactly as migration 0002 created it
-- (the function text below is copied byte for byte from 0002_runs.up.sql), with its grant.
-- Leaves 0001-0003 exactly as they were.
DROP FUNCTION si.si_complete_run(uuid, uuid, jsonb);

CREATE FUNCTION si.si_complete_run(p_run_id uuid, p_lease_token uuid,
  p_received int DEFAULT 0, p_duplicate int DEFAULT 0, p_suppressed int DEFAULT 0, p_conflict int DEFAULT 0)
RETURNS TABLE (outcome text, run_id uuid, retention_state text, publish_control_seq int, finished_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $run_complete$
#variable_conflict use_column
DECLARE
  src text;
  r si.collection_runs%ROWTYPE;
  tick timestamptz;
  pub int;
  ver int;
  retired timestamptz;
  code text;
BEGIN
  -- 1. Spelled differently from the T1/insert-trigger guards, which mutant M5 anchors on exactly.
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: collection runs require READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- M2 publishes EMPTY runs only (Q1): nothing received, published, duplicated or suppressed.
  IF p_received IS DISTINCT FROM 0 OR p_duplicate IS DISTINCT FROM 0 OR p_suppressed IS DISTINCT FROM 0
     OR p_conflict IS NULL OR p_conflict < 0 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: Milestone 2 completes EMPTY runs only' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 2. source_id is immutable: read it without a lock.
  SELECT x.source_id INTO src FROM si.collection_runs x WHERE x.run_id = p_run_id;
  IF NOT FOUND OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'SI_T2_NOT_OWNER: no RUNNING attempt % holds this lease', p_run_id USING ERRCODE = 'check_violation';
  END IF;
  -- 3. Source before run.
  PERFORM 1 FROM si.sources s WHERE s.source_id = src FOR SHARE;                               -- rank 3
  -- 4. Live lease and matching token, read under the run lock.
  SELECT * INTO r FROM si.collection_runs x WHERE x.run_id = p_run_id FOR UPDATE;              -- rank 4
  IF r.status <> 'RUNNING' OR r.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'SI_T2_NOT_OWNER: no RUNNING attempt % holds this lease', p_run_id USING ERRCODE = 'check_violation';
  END IF;
  tick := clock_timestamp();
  IF r.lease_expires_at <= tick THEN
    RAISE EXCEPTION 'SI_T2_LEASE_EXPIRED: lease of run % has expired', p_run_id USING ERRCODE = 'check_violation';
  END IF;
  -- 5. New statements, under the source lock.
  SELECT coalesce(max(c.control_seq), 0) INTO pub FROM si.source_controls c WHERE c.source_id = src;
  SELECT v.version INTO ver FROM si.rights_versions v WHERE v.rights_version_id = r.rights_version_id;
  SELECT s.retired_at INTO retired FROM si.sources s WHERE s.source_id = src;
  code := si.si_t2_control_outcome(src, r.start_control_seq, pub, ver);
  IF code IS NULL AND retired IS NOT NULL AND retired <= tick + si.si_publish_margin() THEN
    code := 'SOURCE_RETIRED';
  END IF;
  IF code IS NULL AND EXISTS (SELECT 1 FROM si.rights_versions n
                               WHERE n.source_id = src AND n.version > ver AND n.effective_from <= tick) THEN
    code := 'RIGHTS_CHANGED';
  END IF;
  IF code IS NULL AND NOT si.rights_valid_for_publish(r.rights_version_id, tick) THEN
    code := 'RIGHTS_EXPIRING';
  END IF;
  IF code IS NOT NULL THEN
    RAISE EXCEPTION 'SI_T2_%: run % cannot be published', code, p_run_id USING ERRCODE = 'check_violation';
  END IF;
  -- 6 + 7. Receipt first, then COMPLETED, in one statement: the UPDATE consumes the receipt
  -- row, so the receipt check is queued first and the publication check last (PB4), and the
  -- deferred checks see both writes even under SET CONSTRAINTS ALL IMMEDIATE (CR-IMM).
  WITH receipt AS (
    INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id)
    VALUES (r.run_id, r.source_id, r.rights_version_id)
    RETURNING run_id)
  UPDATE si.collection_runs x
     SET status = 'COMPLETED', retention_state = 'EMPTY', retain_until = NULL,
         received_count = 0, published_count = 0, duplicate_count = 0, suppressed_count = 0,
         conflict_count = p_conflict, finished_at = tick, rights_checked_at = tick,
         lease_token = NULL, lease_expires_at = NULL, publish_control_seq = pub
    FROM receipt
   WHERE x.run_id = receipt.run_id;
  -- 8.
  RETURN QUERY SELECT 'COMPLETED'::text, r.run_id, 'EMPTY'::text, pub, tick;
END $run_complete$;

REVOKE ALL ON FUNCTION si.si_complete_run(uuid, uuid, int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_complete_run(uuid, uuid, int, int, int, int) TO si_collector;
