-- B-002 migration 0020: M4-P3.1 — immutable per-run advertiser summaries and a per-source identity dictionary
-- (synthetic only). Contract: docs/b002-m4-intelligence.md §15. STORAGE FOUNDATION ONLY: no reader reads these tables
-- (search and history are unchanged; switching them is M4-P3.2). Owner-only tables and functions; no grant changes.
--
-- Design decisions (§15.1):
--  D1 distinct ads: an observation's ad_id is unique per run (UNIQUE (run_id, ad_id)) and ad_id <-> (source, network,
--     native_ad_id) is one-to-one, so each summary row stores the run's sorted ad_ids; distinct ads over any set of runs =
--     count of distinct elements of the union. Per-run counts are never summed for distinct ads.
--  D2 identity = the normalized name (si_normalize_advertiser) under a normalizer fingerprint; the 32-byte digest
--     (si_advertiser_key) is only the index key, CHECKed equal to sha256(normalized_name). A digest that exists with a
--     different normalized name fails the publication closed (SI_SUMMARY_IDENTITY_COLLISION). Raw spellings that
--     normalize equally are the same identity by the existing rule; they are kept per run (names).
--  D3 normalized names (up to 18,000 characters) are stored, never indexed; the unique index is on the digest.
--  D4 normalizer fingerprint 'v1|icu=<und-x-icu actual version>|pg=<major>': recorded on identities and run status; a
--     run whose status fingerprint differs from the current one is STALE (not eligible) and is re-derived by backfill.
--  D5 per run, summary rows and their status record are written in ONE transaction; a source is eligible for
--     summary-backed reads only if every COMPLETED RETAINED/EMPTY run has a current status record and no drift is open
--     (si_summary_coverage). Nothing reads them yet.
--  D6 immutability: summaries and status are append-only; DELETE is admitted only for a PURGED run, a STALE status or a
--     source with open drift; identities only when unreferenced. Observations gain an insert guard: only into a RUNNING
--     run (completed-run evidence can no longer be extended without disabling a trigger, which the gate reports).

------------------------------------------------------------------------------------------
-- Normalizer fingerprint (STABLE: reads the live ICU collation version).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_normalizer_fingerprint() RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $normalizer_fingerprint$
  SELECT 'v1|icu=' || coalesce((SELECT pg_collation_actual_version(c.oid) FROM pg_collation c
                                 WHERE c.collname = 'und-x-icu' AND c.collnamespace = 'pg_catalog'::regnamespace), 'none')
         || '|pg=' || (current_setting('server_version_num')::int / 10000)::text
$normalizer_fingerprint$;

------------------------------------------------------------------------------------------
-- Tables (owner-only).
------------------------------------------------------------------------------------------
CREATE TABLE si.advertiser_identities (
  identity_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        text NOT NULL REFERENCES si.sources (source_id),
  normalizer       text NOT NULL CHECK (normalizer ~ '^v[0-9]+\|'),
  advertiser_key   bytea NOT NULL CHECK (octet_length(advertiser_key) = 32),
  normalized_name  text NOT NULL CHECK (length(normalized_name) <= 18000),
  first_run_id     uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT advertiser_identities_digest CHECK (advertiser_key = sha256(convert_to(normalized_name, 'UTF8'))),
  CONSTRAINT advertiser_identities_key UNIQUE (source_id, normalizer, advertiser_key),
  UNIQUE (identity_id, source_id)
);

CREATE TABLE si.run_advertiser_summaries (
  run_id        uuid NOT NULL,
  source_id     text NOT NULL,
  identity_id   bigint NOT NULL,
  network       text NOT NULL,
  observations  int NOT NULL CHECK (observations > 0),
  ad_ids        bigint[] NOT NULL,
  names         text[] NOT NULL,
  PRIMARY KEY (run_id, identity_id, network),
  CONSTRAINT run_advertiser_summaries_run FOREIGN KEY (run_id, source_id) REFERENCES si.collection_runs (run_id, source_id),
  CONSTRAINT run_advertiser_summaries_identity FOREIGN KEY (identity_id, source_id) REFERENCES si.advertiser_identities (identity_id, source_id),
  CHECK (cardinality(ad_ids) = observations AND array_position(ad_ids, NULL) IS NULL),
  CHECK (cardinality(names) >= 1 AND array_position(names, NULL) IS NULL)
);
CREATE INDEX run_advertiser_summaries_by_identity ON si.run_advertiser_summaries (identity_id);   -- an identity has one source

CREATE TABLE si.run_summary_status (
  run_id             uuid PRIMARY KEY,
  source_id          text NOT NULL,
  normalizer         text NOT NULL CHECK (normalizer ~ '^v[0-9]+\|'),
  observation_count  int NOT NULL CHECK (observation_count >= 0),
  summary_rows       int NOT NULL CHECK (summary_rows >= 0),
  identities         int NOT NULL CHECK (identities >= 0),
  content_digest     bytea NOT NULL CHECK (octet_length(content_digest) = 32),
  method             text NOT NULL CHECK (method IN ('PUBLICATION', 'BACKFILL', 'REBUILD')),
  recorded_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by        text NOT NULL DEFAULT session_user,
  CONSTRAINT run_summary_status_run FOREIGN KEY (run_id, source_id) REFERENCES si.collection_runs (run_id, source_id)
);

CREATE TABLE si.summary_events (
  event_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    text NOT NULL REFERENCES si.sources (source_id),
  run_id       uuid,
  kind         text NOT NULL CHECK (kind IN ('DRIFT_DETECTED', 'DRIFT_CLEARED', 'REBUILT')),
  finding      text CHECK (finding IN ('MISSING', 'CONTENT_MISMATCH', 'STATUS_MISMATCH', 'ORPHAN_IDENTITY', 'IDENTITY_MISMATCH')),
  recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by  text NOT NULL DEFAULT session_user,
  CHECK ((kind = 'DRIFT_DETECTED') = (finding IS NOT NULL))
);
CREATE INDEX summary_events_by_source ON si.summary_events (source_id, event_id);

------------------------------------------------------------------------------------------
-- Open drift: the latest DRIFT_* event of the source is DRIFT_DETECTED.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_summary_drift_open(p_source_id text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $summary_drift_open$
  SELECT coalesce((SELECT e.kind = 'DRIFT_DETECTED' FROM si.summary_events e
                    WHERE e.source_id = p_source_id AND e.kind IN ('DRIFT_DETECTED', 'DRIFT_CLEARED')
                    ORDER BY e.event_id DESC LIMIT 1), false)
$summary_drift_open$;

------------------------------------------------------------------------------------------
-- Guards (data-based admission, as the 0006 evidence guard).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.trg_summary_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $summary_guard$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN                -- nested tests: the cheap admission is checked first
    IF TG_TABLE_NAME = 'run_advertiser_summaries' THEN
      IF EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = OLD.run_id AND r.retention_state = 'PURGED') THEN
        RETURN OLD;
      END IF;
      IF EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = OLD.run_id AND s.normalizer IS DISTINCT FROM si.si_normalizer_fingerprint()) THEN
        RETURN OLD;
      END IF;
      IF si.si_summary_drift_open(OLD.source_id) THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'run_summary_status' THEN
      IF EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = OLD.run_id AND r.retention_state = 'PURGED') THEN
        RETURN OLD;
      END IF;
      IF OLD.normalizer IS DISTINCT FROM si.si_normalizer_fingerprint() THEN
        RETURN OLD;
      END IF;
      IF si.si_summary_drift_open(OLD.source_id) THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'advertiser_identities' THEN
      IF NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries s WHERE s.identity_id = OLD.identity_id) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'SI_SUMMARY_IMMUTABLE: summaries are append-only' USING ERRCODE = '23514';
END $summary_guard$;

CREATE TRIGGER trg_summaries_append_only BEFORE UPDATE OR DELETE ON si.run_advertiser_summaries
FOR EACH ROW EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_summaries_no_truncate BEFORE TRUNCATE ON si.run_advertiser_summaries
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_summary_status_append_only BEFORE UPDATE OR DELETE ON si.run_summary_status
FOR EACH ROW EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_summary_status_no_truncate BEFORE TRUNCATE ON si.run_summary_status
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_identities_append_only BEFORE UPDATE OR DELETE ON si.advertiser_identities
FOR EACH ROW EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_identities_no_truncate BEFORE TRUNCATE ON si.advertiser_identities
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_summary_events_append_only BEFORE UPDATE OR DELETE ON si.summary_events
FOR EACH ROW EXECUTE FUNCTION si.trg_summary_guard();
CREATE TRIGGER trg_summary_events_no_truncate BEFORE TRUNCATE ON si.summary_events
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_summary_guard();

-- Completed-run evidence immutability (D6): observations are inserted only into a RUNNING run (inside si_complete_run,
-- before its status changes). The deferred trg_observation_run_completed still requires COMPLETED at commit.
CREATE FUNCTION si.trg_observation_open_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $observation_open_run$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = NEW.run_id AND r.status = 'RUNNING') THEN
    RAISE EXCEPTION 'SI_EVIDENCE_IMMUTABLE: evidence is added only while its run is being published' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $observation_open_run$;
CREATE TRIGGER trg_observation_open_run BEFORE INSERT ON si.observations
FOR EACH ROW EXECUTE FUNCTION si.trg_observation_open_run();

------------------------------------------------------------------------------------------
-- Derivation from authoritative observations (one definition, used to write and to verify).
------------------------------------------------------------------------------------------
CREATE TYPE si.summary_row AS (advertiser_key bytea, normalized_name text, network text, observations int, ad_ids bigint[], names text[]);

-- One normalizer evaluation per observation; advertiser_key = sha256(normalized name) = si_advertiser_key (0015).
CREATE FUNCTION si.si_summary_content(p_run_id uuid)
RETURNS SETOF si.summary_row
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $summary_content$
  SELECT sha256(convert_to(q.nn, 'UTF8')), q.nn, q.network, count(*)::int, array_agg(q.ad_id ORDER BY q.ad_id),
         array_agg(DISTINCT q.advertiser_name COLLATE "C" ORDER BY q.advertiser_name COLLATE "C")
    FROM (SELECT si.si_normalize_advertiser(o.advertiser_name) AS nn, o.network, o.ad_id, o.advertiser_name
            FROM si.observations o WHERE o.run_id = p_run_id) q
   GROUP BY q.nn, q.network
$summary_content$;

-- Canonical digest of a run's summary content: ordered by digest key and network; arrays as their (unambiguous) literals.
CREATE FUNCTION si.si_summary_digest(p_keys bytea[], p_networks text[], p_observations int[], p_ad_ids text[], p_names text[])
RETURNS bytea
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $summary_digest$
  SELECT sha256(convert_to(coalesce(string_agg(encode(k, 'hex') || '|' || n || '|' || c::text || '|' || a || '|' || m, E'\n'
                                               ORDER BY k, n COLLATE "C"), ''), 'UTF8'))
    FROM unnest(p_keys, p_networks, p_observations, p_ad_ids, p_names) AS u(k, n, c, a, m)
$summary_digest$;

-- Stored content of a run, in the same shape (identity resolved to its key).
CREATE FUNCTION si.si_summary_stored(p_run_id uuid)
RETURNS SETOF si.summary_row
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $summary_stored$
  SELECT i.advertiser_key, i.normalized_name, s.network, s.observations, s.ad_ids, s.names
    FROM si.run_advertiser_summaries s JOIN si.advertiser_identities i ON i.identity_id = s.identity_id
   WHERE s.run_id = p_run_id
$summary_stored$;

------------------------------------------------------------------------------------------
-- Summarize one run (caller holds the source lock: publication FOR SHARE, backfill FOR SHARE, purge excluded).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_summarize_run(p_run_id uuid, p_method text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $summarize_run$
DECLARE
  src text;
  fp text := si.si_normalizer_fingerprint();
  content si.summary_row[];
  nobs int;
  nrows int;
  nids int;
  dg bytea;
BEGIN
  SELECT r.source_id INTO src FROM si.collection_runs r WHERE r.run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_SUMMARY_NO_RUN: run % does not exist', p_run_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  content := ARRAY(SELECT c FROM si.si_summary_content(p_run_id) c);              -- derived once
  -- Identities in one sorted order (concurrent publications of one source wait instead of deadlocking).
  INSERT INTO si.advertiser_identities (source_id, normalizer, advertiser_key, normalized_name, first_run_id)
  SELECT DISTINCT ON (u.advertiser_key) src, fp, u.advertiser_key, u.normalized_name, p_run_id
    FROM unnest(content) u
   WHERE (SELECT 1 FROM si.advertiser_identities e                                    -- existing: no speculative insert;
           WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key) IS NULL   -- a scalar probe, never a hash anti-join
   ORDER BY u.advertiser_key
  ON CONFLICT (source_id, normalizer, advertiser_key) DO NOTHING;                         -- a concurrent publication's
  -- Identity lookups are correlated index probes (LATERAL): no plan can hash the whole dictionary.
  IF EXISTS (SELECT 1 FROM unnest(content) u
               CROSS JOIN LATERAL (SELECT e.normalized_name FROM si.advertiser_identities e
                                    WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key
                                    LIMIT 1) i                                -- LIMIT: never flattened into a hash join
              WHERE i.normalized_name IS DISTINCT FROM u.normalized_name) THEN
    RAISE EXCEPTION 'SI_SUMMARY_IDENTITY_COLLISION: an advertiser digest is recorded for another normalized name'
      USING ERRCODE = '23505';
  END IF;
  INSERT INTO si.run_advertiser_summaries (run_id, source_id, identity_id, network, observations, ad_ids, names)
  SELECT p_run_id, src, i.identity_id, u.network, u.observations, u.ad_ids, u.names
    FROM unnest(content) u
    CROSS JOIN LATERAL (SELECT e.identity_id FROM si.advertiser_identities e
                         WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key LIMIT 1) i;
  GET DIAGNOSTICS nrows = ROW_COUNT;
  SELECT coalesce(sum(u.observations), 0)::int, count(DISTINCT u.advertiser_key)::int,
         si.si_summary_digest(array_agg(u.advertiser_key), array_agg(u.network), array_agg(u.observations),
                              array_agg(u.ad_ids::text), array_agg(u.names::text))
    INTO nobs, nids, dg FROM unnest(content) u;
  IF nrows <> cardinality(content) OR nobs <> (SELECT count(*) FROM si.observations o WHERE o.run_id = p_run_id) THEN
    RAISE EXCEPTION 'SI_SUMMARY_INCONSISTENT: summary of run % does not cover its evidence', p_run_id USING ERRCODE = '23514';
  END IF;
  INSERT INTO si.run_summary_status (run_id, source_id, normalizer, observation_count, summary_rows, identities, content_digest, method)
  VALUES (p_run_id, src, fp, nobs, nrows, nids, dg, p_method);
END $summarize_run$;

------------------------------------------------------------------------------------------
-- Publication: the 0005 si_complete_run with ONE added statement (summaries before the receipt and COMPLETED).
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
  -- 0020 (M4-P3.1): the run's advertiser summaries, in this transaction (fails closed with the publication).
  PERFORM si.si_summarize_run(p_run_id, 'PUBLICATION');
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

-- Commit-time check: a run that becomes COMPLETED has a current summary status covering exactly its evidence.
CREATE FUNCTION si.trg_runs_summary_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $runs_summary_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM si.run_summary_status s
                  WHERE s.run_id = NEW.run_id AND s.normalizer = si.si_normalizer_fingerprint()
                    AND s.observation_count = (SELECT count(*) FROM si.observations o WHERE o.run_id = NEW.run_id)
                    AND s.observation_count = (SELECT coalesce(sum(x.observations), 0) FROM si.run_advertiser_summaries x WHERE x.run_id = NEW.run_id)
                    AND s.summary_rows = (SELECT count(*) FROM si.run_advertiser_summaries x WHERE x.run_id = NEW.run_id)) THEN
    RAISE EXCEPTION 'SI_T2_PERSISTENCE_ERROR: run % is published without a complete summary', NEW.run_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $runs_summary_check$;
CREATE CONSTRAINT TRIGGER trg_runs_summary_check AFTER UPDATE ON si.collection_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED')
EXECUTE FUNCTION si.trg_runs_summary_check();

------------------------------------------------------------------------------------------
-- Purge (unchanged function; this trigger runs inside its transaction, under its exclusive source lock): a run that
-- becomes PURGED loses its summary rows and status; identities of the source left without any summary row are removed.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.trg_runs_purge_summaries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $runs_purge_summaries$
DECLARE
  ids bigint[];
BEGIN
  WITH d AS (DELETE FROM si.run_advertiser_summaries s WHERE s.run_id = NEW.run_id RETURNING s.identity_id)
  SELECT array_agg(DISTINCT d.identity_id) INTO ids FROM d;
  DELETE FROM si.run_summary_status s WHERE s.run_id = NEW.run_id;
  DELETE FROM si.advertiser_identities i
   WHERE i.identity_id = ANY (coalesce(ids, '{}'))
     AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries s WHERE s.identity_id = i.identity_id);
  RETURN NULL;
END $runs_purge_summaries$;
CREATE TRIGGER trg_runs_purge_summaries AFTER UPDATE ON si.collection_runs
FOR EACH ROW WHEN (NEW.retention_state = 'PURGED' AND OLD.retention_state IS DISTINCT FROM 'PURGED')
EXECUTE FUNCTION si.trg_runs_purge_summaries();

------------------------------------------------------------------------------------------
-- Backfill (owner-only; bounded, resumable): runs that are COMPLETED and RETAINED/EMPTY without a current status, in
-- (source, finished_at, run_id) order. Each call is one transaction of at most p_limit runs; a stale status (another
-- normalizer) is removed with its rows and re-derived. Returns the number summarized and the number still missing.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_backfill_summaries(p_limit int DEFAULT 100)
RETURNS TABLE (summarized int, remaining int)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $backfill$
DECLARE
  fp text := si.si_normalizer_fingerprint();
  runs uuid[];
  srcs text[];
  x record;
  done int := 0;
  stale_ids bigint[];
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: backfill requires READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: backfill limit must be between 1 and 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(c.run_id ORDER BY c.source_id, c.finished_at, c.run_id), array_agg(DISTINCT c.source_id)
    INTO runs, srcs
    FROM (SELECT r.run_id, r.source_id, r.finished_at FROM si.collection_runs r
           WHERE r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
             AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = r.run_id AND s.normalizer = fp)
           ORDER BY r.source_id, r.finished_at, r.run_id LIMIT p_limit) c;
  IF runs IS NOT NULL THEN
    PERFORM 1 FROM si.sources s WHERE s.source_id = ANY (srcs) ORDER BY s.source_id FOR SHARE;       -- rank 3
    FOR x IN SELECT r.run_id, r.source_id FROM si.collection_runs r WHERE r.run_id = ANY (runs)
              ORDER BY r.source_id, r.finished_at, r.run_id FOR SHARE LOOP                          -- rank 4
      -- Re-checked under the locks: a purge may have committed before them.
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = x.run_id
                                  AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY'));
      CONTINUE WHEN EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = x.run_id AND s.normalizer = fp);
      IF EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = x.run_id) THEN            -- stale normalizer
        WITH d AS (DELETE FROM si.run_advertiser_summaries s WHERE s.run_id = x.run_id RETURNING s.identity_id)
        SELECT array_agg(DISTINCT d.identity_id) INTO stale_ids FROM d;
        DELETE FROM si.run_summary_status s WHERE s.run_id = x.run_id;
        DELETE FROM si.advertiser_identities i WHERE i.identity_id = ANY (coalesce(stale_ids, '{}'))
           AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries s WHERE s.identity_id = i.identity_id);
      END IF;
      PERFORM si.si_summarize_run(x.run_id, 'BACKFILL');
      done := done + 1;
    END LOOP;
  END IF;
  RETURN QUERY SELECT done, (SELECT count(*)::int FROM si.collection_runs r
                              WHERE r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
                                AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.run_id = r.run_id AND s.normalizer = fp));
END $backfill$;

------------------------------------------------------------------------------------------
-- Verification (owner-only): recompute every summarized run of the source from its observations and compare with the
-- stored rows and status; check the dictionary. Any finding records DRIFT_DETECTED (blocks summary-backed reads); a
-- clean verification of a source with open drift records DRIFT_CLEARED. Returns the findings.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_verify_summaries(p_source_id text)
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
  ELSIF si.si_summary_drift_open(p_source_id) THEN
    INSERT INTO si.summary_events (source_id, kind) VALUES (p_source_id, 'DRIFT_CLEARED');
  END IF;
  RETURN QUERY SELECT u.r, u.k FROM unnest(f_runs, f_kinds) AS u(r, k);
END $verify_summaries$;

-- Rebuild one run from its observations; only while the source has open drift (the guard admits the deletes).
CREATE FUNCTION si.si_rebuild_run_summaries(p_run_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $rebuild$
DECLARE
  src text;
  ids bigint[];
BEGIN
  SELECT r.source_id INTO src FROM si.collection_runs r
   WHERE r.run_id = p_run_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_SUMMARY_NO_RUN: run % is not a retained completed run', p_run_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM si.sources s WHERE s.source_id = src FOR SHARE;
  PERFORM 1 FROM si.collection_runs r WHERE r.run_id = p_run_id FOR SHARE;
  IF NOT si.si_summary_drift_open(src) THEN
    RAISE EXCEPTION 'SI_SUMMARY_NO_DRIFT: rebuild requires recorded drift for source %', src USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  WITH d AS (DELETE FROM si.run_advertiser_summaries s WHERE s.run_id = p_run_id RETURNING s.identity_id)
  SELECT array_agg(DISTINCT d.identity_id) INTO ids FROM d;
  DELETE FROM si.run_summary_status s WHERE s.run_id = p_run_id;
  DELETE FROM si.advertiser_identities i WHERE i.identity_id = ANY (coalesce(ids, '{}'))
     AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries s WHERE s.identity_id = i.identity_id);
  PERFORM si.si_summarize_run(p_run_id, 'REBUILD');
  INSERT INTO si.summary_events (source_id, run_id, kind) VALUES (src, p_run_id, 'REBUILT');
END $rebuild$;

-- For M4-P3.2 (not called by any reader yet): may summary-backed reads be used for this source now?
CREATE FUNCTION si.si_summary_coverage(p_source_id text)
RETURNS TABLE (eligible boolean, reasons text[])
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $summary_coverage$
  SELECT cardinality(x.r) = 0, x.r
    FROM (SELECT array_remove(ARRAY[
            CASE WHEN si.si_summary_drift_open(p_source_id) THEN 'DRIFT' END,
            CASE WHEN EXISTS (SELECT 1 FROM si.collection_runs r
                               WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
                                 AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s
                                                  WHERE s.run_id = r.run_id AND s.normalizer = si.si_normalizer_fingerprint()))
                 THEN 'INCOMPLETE' END], NULL) AS r) x
$summary_coverage$;

------------------------------------------------------------------------------------------
-- Privileges: owner-only tables and functions; si_complete_run keeps its grants (CREATE OR REPLACE).
------------------------------------------------------------------------------------------
REVOKE ALL ON si.advertiser_identities, si.run_advertiser_summaries, si.run_summary_status, si.summary_events FROM PUBLIC;
REVOKE ALL ON TYPE si.summary_row FROM PUBLIC;
REVOKE ALL ON FUNCTION si.si_normalizer_fingerprint(), si.si_summary_drift_open(text), si.trg_summary_guard(),
  si.trg_observation_open_run(), si.si_summary_content(uuid), si.si_summary_digest(bytea[], text[], int[], text[], text[]),
  si.si_summary_stored(uuid), si.si_summarize_run(uuid, text), si.trg_runs_summary_check(), si.trg_runs_purge_summaries(),
  si.si_backfill_summaries(int), si.si_verify_summaries(text), si.si_rebuild_run_summaries(uuid), si.si_summary_coverage(text)
FROM PUBLIC;
