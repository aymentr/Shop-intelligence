-- Reverses 0005. Destructive: the runner requires --allow-destructive and refuses if any
-- non-SYNTHETIC source exists. Restores si_complete_run exactly as migration 0004 created it and
-- trg_runs_publish_check exactly as migration 0002 created it (both texts copied byte for byte;
-- CREATE OR REPLACE keeps their grants), then removes the evidence objects. Leaves 0001-0004 intact.
CREATE OR REPLACE FUNCTION si.si_complete_run(p_run_id uuid, p_lease_token uuid, p_rows jsonb DEFAULT '[]'::jsonb)
RETURNS TABLE (outcome text, run_id uuid, retention_state text, publish_control_seq int, finished_at timestamptz,
               received_count int, published_count int, duplicate_count int, conflict_count int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $run_complete$
#variable_conflict use_column
DECLARE
  src text;
  r si.collection_runs%ROWTYPE;
  scope_fixture text;
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
  -- Evidence persistence is not enabled (M3-P2A): only an empty JSON array is accepted. No read,
  -- lock or write happens before this refusal.
  IF p_rows IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) <> 0 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: only an empty payload is accepted; non-empty completion is not enabled'
      USING ERRCODE = 'invalid_parameter_value';
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
  -- 5a. Request scope (after the authority checks): a scoped run's submission must match its
  -- bound fixture hash. Here the submission is always [], so the scope must be the empty fixture.
  SELECT s.fixture_sha256 INTO scope_fixture FROM si.run_request_scope s WHERE s.run_id = p_run_id;
  IF FOUND AND scope_fixture IS DISTINCT FROM si.si_fixture_sha256_v1('[]'::jsonb) THEN
    RAISE EXCEPTION 'SI_T2_VALIDATION_FAILED: run % was bound to a non-empty fixture; an empty completion does not match it', p_run_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 6 + 7. Receipt first, then COMPLETED, in one statement (D-M2-03). Counts are derived from the
  -- (empty) payload, never supplied by the caller.
  WITH receipt AS (
    INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id)
    VALUES (r.run_id, r.source_id, r.rights_version_id)
    RETURNING run_id)
  UPDATE si.collection_runs x
     SET status = 'COMPLETED', retention_state = 'EMPTY', retain_until = NULL,
         received_count = 0, published_count = 0, duplicate_count = 0, suppressed_count = 0,
         conflict_count = 0, finished_at = tick, rights_checked_at = tick,
         lease_token = NULL, lease_expires_at = NULL, publish_control_seq = pub
    FROM receipt
   WHERE x.run_id = receipt.run_id;
  -- 8. Counts only; never content.
  RETURN QUERY SELECT 'COMPLETED'::text, r.run_id, 'EMPTY'::text, pub, tick, 0, 0, 0, 0;
END $run_complete$;

CREATE OR REPLACE FUNCTION si.trg_runs_publish_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $run_publish_check$
DECLARE
  r si.collection_runs%ROWTYPE;
  pub int;
  ver int;
  code text;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: collection runs require READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM 1 FROM si.sources s WHERE s.source_id = NEW.source_id FOR SHARE;     -- already held by T2
  SELECT * INTO r FROM si.collection_runs x WHERE x.run_id = NEW.run_id;
  SELECT coalesce(max(c.control_seq), 0) INTO pub FROM si.source_controls c WHERE c.source_id = r.source_id;
  SELECT v.version INTO ver FROM si.rights_versions v WHERE v.rights_version_id = r.rights_version_id;
  IF r.publish_control_seq IS DISTINCT FROM pub THEN
    code := 'SOURCE_SUSPENDED';                            -- a control committed after T2 decided
  ELSE
    code := si.si_t2_control_outcome(r.source_id, r.start_control_seq, pub, ver);
  END IF;
  IF code IS NULL AND NOT si.rights_valid_for_publish(r.rights_version_id, clock_timestamp()) THEN
    code := 'RIGHTS_EXPIRING';
  END IF;
  IF code IS NULL AND (r.published_count <> 0 OR r.suppressed_count <> 0
       OR NOT EXISTS (SELECT 1 FROM si.publication_receipts p
                       WHERE p.run_id = r.run_id AND p.source_id = r.source_id
                         AND p.rights_version_id = r.rights_version_id)) THEN
    code := 'PERSISTENCE_ERROR';
  END IF;
  IF code IS NOT NULL THEN
    RAISE EXCEPTION 'SI_T2_%: publication check failed for run %', code, r.run_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $run_publish_check$;

DROP TABLE si.observations;
DROP TABLE si.ads;
DROP FUNCTION si.si_t2_row_error(jsonb);
DROP FUNCTION si.si_t2_fingerprint(jsonb);
DROP TYPE si.t2_stage_row;
DROP FUNCTION si.trg_ad_has_observation();
DROP FUNCTION si.trg_observation_run_completed();
DROP FUNCTION si.trg_evidence_append_only();
