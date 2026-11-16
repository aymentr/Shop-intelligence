-- B-002 migration 0020 down: removes the summary storage and restores si_complete_run exactly as migration 0005 created it.
DROP TRIGGER trg_runs_purge_summaries ON si.collection_runs;
DROP TRIGGER trg_runs_summary_check ON si.collection_runs;
DROP TRIGGER trg_observation_open_run ON si.observations;
CREATE OR REPLACE FUNCTION si.si_complete_run(p_run_id uuid, p_lease_token uuid, p_rows jsonb DEFAULT '[]'::jsonb)
RETURNS TABLE (outcome text, run_id uuid, retention_state text, publish_control_seq int, finished_at timestamptz,
               received_count int, published_count int, duplicate_count int, conflict_count int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $run_complete$
#variable_conflict use_column
DECLARE
  src text;
  policy text;
  r si.collection_runs%ROWTYPE;
  s si.run_request_scope%ROWTYPE;
  scoped boolean;
  supported text[];
  rws si.t2_stage_row[];
  nrows int;
  h text;
  nerr int;
  errs jsonb;
  uniq int;
  dup int;
  cnf int;
  conf jsonb;
  net_bad int;
  net_errs jsonb;
  tick timestamptz;
  pub int;
  ver int;
  days int;
  retired timestamptz;
  keep_until timestamptz;
  code text;
  a record;
BEGIN
  -- Phase A. Spelled differently from the T1/insert-trigger guards, which mutant M5 anchors on.
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: collection runs require READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_rows) > 500 OR octet_length(p_rows::text) > 1048576 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: the payload must be a JSON array of at most 500 rows and 1 MiB'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  nrows := jsonb_array_length(p_rows);
  IF nrows > 0 AND NOT (current_setting('log_parameter_max_length') = '0'
       AND current_setting('log_parameter_max_length_on_error') = '0'
       AND current_setting('log_statement') IN ('none', 'ddl')
       AND current_setting('log_min_duration_statement') = '-1'
       AND current_setting('log_min_duration_sample') = '-1'
       AND current_setting('log_transaction_sample_rate')::float8 = 0) THEN
    RAISE EXCEPTION 'SI_UNSAFE_LOGGING: this session could log evidence parameters' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- source_id and the conflict-policy snapshot are immutable: read them without a lock.
  SELECT x.source_id, x.conflict_policy INTO src, policy FROM si.collection_runs x WHERE x.run_id = p_run_id;
  IF NOT FOUND OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'SI_T2_NOT_OWNER: no RUNNING attempt % holds this lease', p_run_id USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    h := si.si_fixture_sha256_v1(p_rows);
  EXCEPTION WHEN invalid_parameter_value THEN
    h := NULL;                                                   -- not reproducible: cannot match a fixture
  END;
  SELECT coalesce(array_agg(ROW((e.o - 1)::int, e.v, e.v->>'network', e.v->>'nativeAdId',
           CASE WHEN jsonb_typeof(e.v) = 'object' THEN si.si_t2_fingerprint(e.v) END,
           coalesce(ve.code, CASE WHEN jsonb_typeof(e.v) = 'object' AND si.si_t2_fingerprint(e.v) IS NULL THEN 'INVALID_SHAPE' END),
           ve.field)::si.t2_stage_row ORDER BY e.o), '{}')
    INTO rws
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(v, o)
    LEFT JOIN LATERAL si.si_t2_row_error(e.v) ve ON true;
  SELECT count(*) FILTER (WHERE t.ecode IS NOT NULL),
         coalesce(jsonb_agg(jsonb_build_object('c', t.ecode, 'r', t.ordinal, 'f', t.efield) ORDER BY t.ordinal)
                    FILTER (WHERE t.ecode IS NOT NULL), '[]'::jsonb)
    INTO nerr, errs FROM unnest(rws) t;
  -- Deterministic dedupe: identity (network, nativeAdId); the lowest ordinal is kept; a conflict
  -- is a duplicate whose fingerprint differs from the kept row's (B-001 relation).
  SELECT count(*) FILTER (WHERE d.rn = 1), count(*) FILTER (WHERE d.rn > 1),
         count(*) FILTER (WHERE d.rn > 1 AND d.fp IS DISTINCT FROM d.kept_fp),
         coalesce(jsonb_agg(jsonb_build_object('c', 'DUPLICATE_CONFLICT', 'r', d.ordinal, 'f', NULL) ORDER BY d.ordinal)
                    FILTER (WHERE d.rn > 1 AND d.fp IS DISTINCT FROM d.kept_fp), '[]'::jsonb)
    INTO uniq, dup, cnf, conf
    FROM (SELECT t.ordinal, t.fp,
                 row_number() OVER (PARTITION BY t.net, t.nid ORDER BY t.ordinal) AS rn,
                 first_value(t.fp) OVER (PARTITION BY t.net, t.nid ORDER BY t.ordinal) AS kept_fp
            FROM unnest(rws) t) d;

  -- Phase B (unchanged from 0004): source before run; live lease; rights and controls.
  PERFORM 1 FROM si.sources x WHERE x.source_id = src FOR SHARE;                                -- rank 3
  SELECT * INTO r FROM si.collection_runs x WHERE x.run_id = p_run_id FOR UPDATE;              -- rank 4
  IF r.status <> 'RUNNING' OR r.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'SI_T2_NOT_OWNER: no RUNNING attempt % holds this lease', p_run_id USING ERRCODE = 'check_violation';
  END IF;
  tick := clock_timestamp();
  IF r.lease_expires_at <= tick THEN
    RAISE EXCEPTION 'SI_T2_LEASE_EXPIRED: lease of run % has expired', p_run_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(c.control_seq), 0) INTO pub FROM si.source_controls c WHERE c.source_id = src;
  SELECT v.version, v.retention_days INTO ver, days FROM si.rights_versions v WHERE v.rights_version_id = r.rights_version_id;
  SELECT x.retired_at, x.supported_networks INTO retired, supported FROM si.sources x WHERE x.source_id = src;
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

  -- Phase C. Scoped runs: the submission must be exactly the bound fixture (also when empty).
  SELECT * INTO s FROM si.run_request_scope x WHERE x.run_id = p_run_id;
  scoped := FOUND;
  IF scoped AND h IS DISTINCT FROM s.fixture_sha256 THEN
    RAISE EXCEPTION 'SI_T2_VALIDATION_FAILED: the payload does not match the bound fixture of run %', p_run_id
      USING ERRCODE = 'check_violation', DETAIL = '{"v":1,"n":1,"e":[{"c":"REQUEST_HASH_MISMATCH","r":null,"f":null}]}';
  END IF;
  IF NOT scoped AND nrows > 0 THEN
    RAISE EXCEPTION 'SI_T2_VALIDATION_FAILED: run % has no request scope; only an empty completion is possible', p_run_id
      USING ERRCODE = 'check_violation', DETAIL = '{"v":1,"n":1,"e":[{"c":"REQUEST_SCOPE_MISSING","r":null,"f":null}]}';
  END IF;
  -- Network authorization (valid network values only; an unknown value is INVALID_NETWORK below).
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('c', 'NETWORK_NOT_AUTHORIZED', 'r', t.ordinal, 'f', 'network') ORDER BY t.ordinal), '[]'::jsonb)
    INTO net_bad, net_errs
    FROM unnest(rws) t
   WHERE t.net IN ('META','TIKTOK','GOOGLE','PINTEREST','OTHER')
     AND NOT (t.net = ANY (s.networks) AND t.net = ANY (supported));
  IF net_bad > 0 THEN
    RAISE EXCEPTION 'SI_T2_VALIDATION_FAILED: % rows name a network outside the authorized scope', net_bad
      USING ERRCODE = 'check_violation',
            DETAIL = jsonb_build_object('v', 1, 'n', net_bad, 'e', (SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(net_errs) x LIMIT 100) q))::text;
  END IF;
  IF nerr > 0 THEN
    RAISE EXCEPTION 'SI_T2_VALIDATION_FAILED: % invalid rows', nerr
      USING ERRCODE = 'check_violation',
            DETAIL = jsonb_build_object('v', 1, 'n', nerr, 'e', (SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(errs) x LIMIT 100) q))::text;
  END IF;
  IF policy = 'FAIL_RUN' AND cnf > 0 THEN
    RAISE EXCEPTION 'SI_T2_DUPLICATE_CONFLICT: % conflicting duplicates', cnf
      USING ERRCODE = 'check_violation',
            DETAIL = jsonb_build_object('v', 1, 'n', cnf, 'e', (SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(conf) x LIMIT 100) q))::text;
  END IF;

  -- Phase D. Ad identities in a single sorted order: concurrent completions that share
  -- identities wait on each other instead of deadlocking.
  FOR a IN SELECT DISTINCT t.net COLLATE "C" AS net, t.nid COLLATE "C" AS nid FROM unnest(rws) t ORDER BY 1, 2 LOOP
    INSERT INTO si.ads (source_id, network, native_ad_id, first_run_id) VALUES (src, a.net, a.nid, p_run_id)
      ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
                               countries, seen_at, source_url, title, destination_url, creative_url,
                               source_reported_first_seen, source_reported_last_seen, content_sha256)
  SELECT p_run_id, src, r.rights_version_id, k.ordinal, ad.ad_id, k.net, k.nid, k.row_data->>'advertiserName',
         ARRAY(SELECT jsonb_array_elements_text(k.row_data->'countries')), (k.row_data->>'seenAt')::timestamptz,
         k.row_data->>'sourceUrl', k.row_data->>'title', k.row_data->>'destinationUrl', k.row_data->>'creativeUrl',
         (k.row_data->>'sourceReportedFirstSeen')::timestamptz, (k.row_data->>'sourceReportedLastSeen')::timestamptz, k.fp
    FROM (SELECT t.*, row_number() OVER (PARTITION BY t.net, t.nid ORDER BY t.ordinal) AS rn FROM unnest(rws) t) k
    JOIN si.ads ad ON ad.source_id = src AND ad.network = k.net AND ad.native_ad_id = k.nid
   WHERE k.rn = 1;
  -- Static retention metadata: an upper bound from the collected version; the effective end is
  -- re-evaluated dynamically by the (later) retention migration. Not enforced here.
  keep_until := CASE WHEN nrows = 0 THEN NULL
                     ELSE LEAST(tick + make_interval(days => days), si.si_retention_end(src, ver)) END;
  -- Receipt first, then COMPLETED, in one statement (D-M2-03).
  WITH receipt AS (
    INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id)
    VALUES (r.run_id, r.source_id, r.rights_version_id)
    RETURNING run_id)
  UPDATE si.collection_runs x
     SET status = 'COMPLETED', retention_state = CASE WHEN nrows = 0 THEN 'EMPTY' ELSE 'RETAINED' END,
         retain_until = keep_until,
         received_count = nrows, published_count = uniq, duplicate_count = dup, suppressed_count = 0,
         conflict_count = cnf, finished_at = tick, rights_checked_at = tick,
         lease_token = NULL, lease_expires_at = NULL, publish_control_seq = pub
    FROM receipt
   WHERE x.run_id = receipt.run_id;
  -- Counts only; never content.
  RETURN QUERY SELECT 'COMPLETED'::text, r.run_id, CASE WHEN nrows = 0 THEN 'EMPTY' ELSE 'RETAINED' END, pub, tick,
    nrows, uniq, dup, cnf;
END $run_complete$;
DROP FUNCTION si.si_summary_coverage(text), si.si_rebuild_run_summaries(uuid), si.si_verify_summaries(text),
  si.si_backfill_summaries(int), si.trg_runs_purge_summaries(), si.trg_runs_summary_check(), si.si_summarize_run(uuid, text),
  si.si_summary_stored(uuid), si.si_summary_digest(bytea[], text[], int[], text[], text[]), si.si_summary_content(uuid),
  si.trg_observation_open_run();
DROP TABLE si.summary_events, si.run_summary_status, si.run_advertiser_summaries, si.advertiser_identities;
DROP FUNCTION si.trg_summary_guard(), si.si_summary_drift_open(text), si.si_normalizer_fingerprint();
DROP TYPE si.summary_row;
