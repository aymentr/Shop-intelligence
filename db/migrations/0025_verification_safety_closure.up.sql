-- B-002 migration 0025: M4-P3.3-P2-CLOSE-01 — batched verification safety closure (docs §18.1, §18.7).
-- Changes exactly two functions with CREATE OR REPLACE (owner, privileges, volatility and pinned settings unchanged):
--   si_verify_summaries (0020): a clean full-source pass no longer records DRIFT_CLEARED. Its findings, its DRIFT_DETECTED
--     records, its owner-only authorization and the reader's fallback are unchanged. Clearing drift is possible only
--     through si_summary_clear_drift (the authorized recovery, with its clearance record).
--   si_summary_clear_drift (0024): additionally requires READ COMMITTED, a sweep under the CURRENT normalizer fingerprint,
--     and that no run or identity inside the sweep's boundary exists without this sweep's VERIFIED record (a late commit
--     after the gap phase). COMPLETED_CLEAN itself is unchanged.
-- Down restores the exact 0024 catalog.

CREATE OR REPLACE FUNCTION si.si_verify_summaries(p_source_id text)
RETURNS TABLE (run_id uuid, finding text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $verify_summaries$
DECLARE
  fp text := si.si_normalizer_fingerprint();
  f_runs uuid[];
  f_kinds text[];
BEGIN
  PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR SHARE;
  SELECT coalesce(array_agg(f.r ORDER BY f.k, f.r), '{}'), coalesce(array_agg(f.k ORDER BY f.k, f.r), '{}') INTO f_runs, f_kinds
    FROM (
      SELECT r.run_id AS r, 'MISSING'::text AS k FROM si.collection_runs r
       WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
         AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = r.run_id)
      UNION ALL
      SELECT s.run_id, 'CONTENT_MISMATCH' FROM si.run_summary_status s
       WHERE s.source_id = p_source_id AND s.normalizer = fp
         AND (EXISTS (SELECT * FROM si.si_summary_content(s.run_id) EXCEPT ALL SELECT * FROM si.si_summary_stored(s.run_id))
              OR EXISTS (SELECT * FROM si.si_summary_stored(s.run_id) EXCEPT ALL SELECT * FROM si.si_summary_content(s.run_id)))
      UNION ALL
      SELECT s.run_id, 'STATUS_MISMATCH' FROM si.run_summary_status s
       WHERE s.source_id = p_source_id AND s.normalizer = fp
         AND (s.observation_count <> (SELECT count(*) FROM si.observations o WHERE o.run_id = s.run_id)
              OR s.summary_rows <> (SELECT count(*) FROM si.run_advertiser_summaries x WHERE x.run_id = s.run_id)
              OR s.content_digest IS DISTINCT FROM (SELECT si.si_summary_digest(array_agg(c.advertiser_key), array_agg(c.network),
                                                      array_agg(c.observations), array_agg(c.ad_ids::text), array_agg(c.names::text))
                                                    FROM si.si_summary_content(s.run_id) c))
      UNION ALL
      SELECT NULL::uuid, 'ORPHAN_IDENTITY' FROM si.advertiser_identities i
       WHERE i.source_id = p_source_id AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries x WHERE x.identity_id = i.identity_id)
      UNION ALL
      SELECT NULL::uuid, 'IDENTITY_MISMATCH' FROM si.advertiser_identities i
       WHERE i.source_id = p_source_id AND i.advertiser_key IS DISTINCT FROM sha256(convert_to(i.normalized_name, 'UTF8'))) f;
  IF cardinality(f_kinds) > 0 THEN
    INSERT INTO si.summary_events (source_id, run_id, kind, finding)
    SELECT DISTINCT p_source_id, u.r, 'DRIFT_DETECTED', u.k FROM unnest(f_runs, f_kinds) AS u(r, k);
  END IF;                                     -- 0025: a clean pass records nothing; clearance is si_summary_clear_drift only
  RETURN QUERY SELECT u.r, u.k FROM unnest(f_runs, f_kinds) AS u(r, k);
END $verify_summaries$;

CREATE OR REPLACE FUNCTION si.si_summary_clear_drift(p_source_id text, p_sweep_id bigint)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $clear_drift$
DECLARE
  w record;
  ev bigint;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN   -- each check below needs a fresh snapshot
    RAISE EXCEPTION 'SI_ISOLATION: drift clearance requires READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_SWEEP_NO_SOURCE: unknown source' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT si.si_summary_drift_open(p_source_id) THEN
    RAISE EXCEPTION 'SI_SUMMARY_NO_DRIFT: no open drift for the source' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO w FROM si.summary_sweeps s WHERE s.sweep_id = p_sweep_id AND s.source_id = p_source_id;
  IF NOT FOUND OR w.state <> 'COMPLETED_CLEAN' THEN
    RAISE EXCEPTION 'SI_SWEEP_NOT_CLEAN: clearance requires a COMPLETED_CLEAN sweep of the source' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (SELECT 1 FROM si.summary_events e WHERE e.source_id = p_source_id AND e.event_id > w.start_event_id
                AND e.kind IN ('DRIFT_DETECTED', 'REBUILT')) THEN
    RAISE EXCEPTION 'SI_SWEEP_SUPERSEDED: drift or a rebuild was recorded after the sweep started' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.normalizer IS DISTINCT FROM si.si_normalizer_fingerprint() THEN
    RAISE EXCEPTION 'SI_SWEEP_STALE_FINGERPRINT: the sweep ran under another normalizer fingerprint' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Late commits (docs §18.1): a run or identity inside the sweep's boundary that committed after its gap phase was never
  -- verified by it. Under the source lock (publication holds FOR SHARE until it commits) and a fresh snapshot, every such
  -- item that exists now must carry this sweep's VERIFIED record; otherwise a new sweep is required.
  IF EXISTS (SELECT 1 FROM si.collection_runs r
              WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
                AND w.boundary_run_id IS NOT NULL AND (r.finished_at, r.run_id) <= (w.boundary_finished_at, w.boundary_run_id)
                AND NOT EXISTS (SELECT 1 FROM si.summary_sweep_runs v
                                 WHERE v.sweep_id = w.sweep_id AND v.run_id = r.run_id AND v.outcome = 'VERIFIED'))
     OR EXISTS (SELECT 1 FROM si.advertiser_identities i
                 WHERE i.source_id = p_source_id AND w.boundary_identity_id IS NOT NULL AND i.identity_id <= w.boundary_identity_id
                   AND NOT EXISTS (SELECT 1 FROM si.summary_sweep_identities v
                                    WHERE v.sweep_id = w.sweep_id AND v.identity_id = i.identity_id AND v.outcome = 'VERIFIED')) THEN
    RAISE EXCEPTION 'SI_SWEEP_SCOPE_INCOMPLETE: an item inside the sweep boundary committed after its gap phase; run a new sweep' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO si.summary_events (source_id, kind) VALUES (p_source_id, 'DRIFT_CLEARED') RETURNING event_id INTO ev;
  INSERT INTO si.summary_drift_clearances (event_id, source_id, sweep_id) VALUES (ev, p_source_id, p_sweep_id);
  RETURN ev;
END $clear_drift$;
