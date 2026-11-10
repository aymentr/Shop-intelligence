-- B-002 migration 0005: Milestone 3 part 2B — atomic evidence persistence (synthetic sources only).
-- Contract: docs/b002-m3-design.md.
--
-- One migration, because no subset is safe: a non-empty T2 without the replacement publication
-- check would fail every commit, and the check without the evidence tables has nothing to count.
--   - si.ads: per-source ad identity registry (identity only, no content);
--   - si.observations: one kept, typed record per identity per COMPLETED run;
--   - append-only guards and insert-scoped deferred integrity checks;
--   - si_complete_run (same signature and return type as 0004) now accepts a bounded, validated,
--     scope- and fixture-bound payload, deduplicates it deterministically and persists it atomically;
--   - trg_runs_publish_check verifies the derived counts against the stored observations.
-- No application role can read or write the evidence tables. No content is returned or served.
-- Authority, lease, rights, control and lock-order checks of T2 are those of 0004, unchanged.

------------------------------------------------------------------------------------------
-- Evidence tables
------------------------------------------------------------------------------------------
CREATE TABLE si.ads (
  ad_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     text NOT NULL REFERENCES si.sources (source_id),
  network       text NOT NULL CHECK (network IN ('META','TIKTOK','GOOGLE','PINTEREST','OTHER')),
  native_ad_id  text NOT NULL CHECK (length(native_ad_id) >= 1 AND length(native_ad_id) <= 256
                  AND native_ad_id !~ '[\x01-\x1f\x7f-\x9f]'),          -- flat AND: deparses identically after dump/restore
  first_run_id  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, network, native_ad_id),
  UNIQUE (ad_id, source_id, network, native_ad_id)                          -- composite FK target
);

-- Every CHECK below is implied by si_t2_row_error, so validated rows never reach a CHECK (whose
-- standard error detail would quote the failing row).
CREATE TABLE si.observations (
  run_id                      uuid NOT NULL,
  source_id                   text NOT NULL,
  rights_version_id           bigint NOT NULL,
  ordinal                     int  NOT NULL CHECK (ordinal BETWEEN 0 AND 499),
  ad_id                       bigint NOT NULL,
  network                     text NOT NULL,
  native_ad_id                text NOT NULL,
  advertiser_name             text NOT NULL CHECK (length(advertiser_name) BETWEEN 1 AND 1000),
  countries                   text[] NOT NULL CHECK (cardinality(countries) > 0 AND array_ndims(countries) = 1
                                AND array_position(countries, NULL) IS NULL
                                AND array_to_string(countries, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'),
  seen_at                     timestamptz NOT NULL,
  source_url                  text NOT NULL CHECK (length(source_url) <= 2048 AND source_url ~ '^https?://'),
  title                       text CHECK (length(title) BETWEEN 1 AND 1000),
  destination_url             text CHECK (length(destination_url) <= 2048 AND destination_url ~ '^https?://'),
  creative_url                text CHECK (length(creative_url) <= 2048 AND creative_url ~ '^https?://'),
  source_reported_first_seen  timestamptz,
  source_reported_last_seen   timestamptz,
  content_sha256              text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, ad_id),
  CHECK (source_reported_first_seen IS NULL OR source_reported_last_seen IS NULL
         OR source_reported_first_seen <= source_reported_last_seen),
  -- the observation names exactly its run's source and rights version (IA-1 pattern)
  CONSTRAINT observations_run FOREIGN KEY (run_id, source_id, rights_version_id)
    REFERENCES si.collection_runs (run_id, source_id, rights_version_id),
  -- and exactly the identity it is filed under; RESTRICT keeps identities while evidence exists
  CONSTRAINT observations_ad FOREIGN KEY (ad_id, source_id, network, native_ad_id)
    REFERENCES si.ads (ad_id, source_id, network, native_ad_id) ON DELETE RESTRICT
);

-- Append-only for every role, including si_owner. A trigger function (not a rule or CHECK) so
-- that a later retention migration can replace it to admit only a controlled purge routine.
CREATE FUNCTION si.trg_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $evidence_guard$
BEGIN
  RAISE EXCEPTION 'SI_EVIDENCE_IMMUTABLE: evidence cannot be changed or removed' USING ERRCODE = '23514';
END $evidence_guard$;

CREATE TRIGGER trg_ads_append_only BEFORE UPDATE OR DELETE ON si.ads
FOR EACH ROW EXECUTE FUNCTION si.trg_evidence_append_only();
CREATE TRIGGER trg_ads_no_truncate BEFORE TRUNCATE ON si.ads
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_evidence_append_only();
CREATE TRIGGER trg_observations_append_only BEFORE UPDATE OR DELETE ON si.observations
FOR EACH ROW EXECUTE FUNCTION si.trg_evidence_append_only();
CREATE TRIGGER trg_observations_no_truncate BEFORE TRUNCATE ON si.observations
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_evidence_append_only();

-- Insert-scoped deferred integrity (fires on INSERT only, so a later purge never fires it).
-- SECURITY DEFINER because deferred checks fire at COMMIT as the session role; read-only.
CREATE FUNCTION si.trg_observation_run_completed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $obs_completed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = NEW.run_id AND r.status = 'COMPLETED') THEN
    RAISE EXCEPTION 'SI_OBSERVATION_RUN_NOT_COMPLETED: observations belong only to COMPLETED runs' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $obs_completed$;

CREATE CONSTRAINT TRIGGER trg_observation_run_completed AFTER INSERT ON si.observations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION si.trg_observation_run_completed();

CREATE FUNCTION si.trg_ad_has_observation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $ad_observed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = NEW.ad_id) THEN
    RAISE EXCEPTION 'SI_AD_WITHOUT_OBSERVATION: an ad identity is recorded only with its evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $ad_observed$;

CREATE CONSTRAINT TRIGGER trg_ad_has_observation AFTER INSERT ON si.ads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION si.trg_ad_has_observation();

------------------------------------------------------------------------------------------
-- Validation and canonicalization (deterministic; rejects, never normalizes)
------------------------------------------------------------------------------------------
-- In-memory staging row (si_owner has no TEMP privilege by design).
CREATE TYPE si.t2_stage_row AS (ordinal int, row_data jsonb, net text, nid text, fp text, ecode text, efield text);

-- Content fingerprint excluding seenAt (re-observation is not a conflict), or NULL when the row
-- cannot be canonicalized exactly (numbers, non-ASCII keys): such rows are INVALID_SHAPE.
CREATE FUNCTION si.si_t2_fingerprint(p_row jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $fingerprint$
BEGIN
  RETURN encode(sha256(convert_to(si.si_canonical_json_v1(p_row - 'seenAt'), 'UTF8')), 'hex');
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN NULL;
END $fingerprint$;

-- First error of a row as (code, field), or no row when valid. B-001 canonical form is required.
CREATE FUNCTION si.si_t2_row_error(p_row jsonb) RETURNS TABLE (code text, field text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $row_error$
DECLARE
  ws  constant text := '^[[:space:]\u00a0\ufeff\u2028\u2029]|[[:space:]\u00a0\ufeff\u2028\u2029]$';
  ts  constant text := '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$';
  url constant text := '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$';
  k text;
  t timestamptz;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN
    code := 'INVALID_SHAPE'; RETURN NEXT; RETURN;
  END IF;
  IF jsonb_typeof(p_row->'network') IS DISTINCT FROM 'string'
     OR p_row->>'network' NOT IN ('META','TIKTOK','GOOGLE','PINTEREST','OTHER') THEN
    code := 'INVALID_NETWORK'; field := 'network'; RETURN NEXT; RETURN;
  END IF;
  IF jsonb_typeof(p_row->'nativeAdId') IS DISTINCT FROM 'string' OR p_row->>'nativeAdId' = ''
     OR length(p_row->>'nativeAdId') > 256 OR p_row->>'nativeAdId' ~ '[\x01-\x1f\x7f-\x9f]' OR p_row->>'nativeAdId' ~ ws THEN
    code := 'INVALID_NATIVE_AD_ID'; field := 'nativeAdId'; RETURN NEXT; RETURN;
  END IF;
  FOREACH k IN ARRAY ARRAY['advertiserName', 'title'] LOOP
    IF (k = 'advertiserName' OR p_row ? k)
       AND (jsonb_typeof(p_row->k) IS DISTINCT FROM 'string' OR p_row->>k = '' OR p_row->>k ~ ws OR length(p_row->>k) > 1000) THEN
      code := 'INVALID_TEXT'; field := k; RETURN NEXT; RETURN;
    END IF;
  END LOOP;
  IF jsonb_typeof(p_row->'countries') IS DISTINCT FROM 'array' OR jsonb_array_length(p_row->'countries') = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_row->'countries') e
                 WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' !~ '^[A-Z]{2}$')
     OR (SELECT array_agg(e #>> '{}' ORDER BY o) FROM jsonb_array_elements(p_row->'countries') WITH ORDINALITY x(e, o))
        IS DISTINCT FROM
        (SELECT array_agg(DISTINCT e #>> '{}' COLLATE "C" ORDER BY e #>> '{}' COLLATE "C") FROM jsonb_array_elements(p_row->'countries') e) THEN
    code := 'INVALID_COUNTRIES'; field := 'countries'; RETURN NEXT; RETURN;
  END IF;
  FOREACH k IN ARRAY ARRAY['seenAt', 'sourceReportedFirstSeen', 'sourceReportedLastSeen'] LOOP
    IF k = 'seenAt' OR p_row ? k THEN
      IF jsonb_typeof(p_row->k) IS DISTINCT FROM 'string' OR p_row->>k !~ ts THEN
        code := 'INVALID_TIMESTAMP'; field := k; RETURN NEXT; RETURN;
      END IF;
      BEGIN
        t := (p_row->>k)::timestamptz;
      EXCEPTION WHEN others THEN
        code := 'INVALID_TIMESTAMP'; field := k; RETURN NEXT; RETURN;
      END;
      IF to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_row->>k THEN
        code := 'INVALID_TIMESTAMP'; field := k; RETURN NEXT; RETURN;               -- e.g. Feb 30 rolled over
      END IF;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['sourceUrl', 'destinationUrl', 'creativeUrl'] LOOP
    IF (k = 'sourceUrl' OR p_row ? k)
       AND (jsonb_typeof(p_row->k) IS DISTINCT FROM 'string' OR p_row->>k !~ url OR length(p_row->>k) > 2048) THEN
      code := 'INVALID_URL'; field := k; RETURN NEXT; RETURN;
    END IF;
  END LOOP;
  IF p_row ? 'sourceReportedFirstSeen' AND p_row ? 'sourceReportedLastSeen'
     AND (p_row->>'sourceReportedFirstSeen')::timestamptz > (p_row->>'sourceReportedLastSeen')::timestamptz THEN
    code := 'SEEN_ORDER'; field := 'sourceReportedFirstSeen'; RETURN NEXT; RETURN;
  END IF;
  RETURN;
END $row_error$;

------------------------------------------------------------------------------------------
-- T2 (same signature and return type as 0004; CREATE OR REPLACE keeps the grant)
--   Phase A — no lock, no write: isolation, payload bounds, logging tripwire (secondary to the
--             library's preflight), staging, validation, fingerprints, dedupe and conflict counts.
--   Phase B — locks and authority, unchanged from 0004 (sources FOR SHARE -> run FOR UPDATE).
--   Phase C — refusals: scope/fixture, network authorization, invalid rows, FAIL_RUN conflicts.
--   Phase D — writes: ad identities in sorted order, kept observations, receipt + COMPLETED.
-- Refusals raise SI_T2_<CODE> (23514) with a bounded JSON DETAIL of codes, row indices and field
-- names only: {"v":1,"n":<total>,"e":[{"c":code,"r":row|null,"f":field|null}, ... at most 100]}.
------------------------------------------------------------------------------------------
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

------------------------------------------------------------------------------------------
-- Commit-time publication check, extended: the derived counts must match the stored evidence.
------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION si.trg_runs_publish_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $run_publish_check$
DECLARE
  r si.collection_runs%ROWTYPE;
  pub int;
  ver int;
  obs int;
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
  SELECT count(*) INTO obs FROM si.observations o WHERE o.run_id = r.run_id;
  IF r.publish_control_seq IS DISTINCT FROM pub THEN
    code := 'SOURCE_SUSPENDED';                            -- a control committed after T2 decided
  ELSE
    code := si.si_t2_control_outcome(r.source_id, r.start_control_seq, pub, ver);
  END IF;
  IF code IS NULL AND NOT si.rights_valid_for_publish(r.rights_version_id, clock_timestamp()) THEN
    code := 'RIGHTS_EXPIRING';
  END IF;
  IF code IS NULL AND (r.suppressed_count <> 0 OR r.published_count <> obs
       OR r.received_count <> r.published_count + r.duplicate_count OR r.conflict_count > r.duplicate_count
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

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC; no application-role privilege on the evidence tables or the
-- staging type; si_complete_run keeps its 0004 grant (si_collector only).
------------------------------------------------------------------------------------------
REVOKE ALL ON si.ads, si.observations FROM PUBLIC;
REVOKE ALL ON TYPE si.t2_stage_row FROM PUBLIC;
REVOKE ALL ON FUNCTION si.trg_evidence_append_only(), si.trg_observation_run_completed(), si.trg_ad_has_observation(),
  si.si_t2_fingerprint(jsonb), si.si_t2_row_error(jsonb)
FROM PUBLIC;
