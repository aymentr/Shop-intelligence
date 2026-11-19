-- B-002 migration 0026: M4-P3.3 Phase 3 — content-free operational observability (docs §19). Synthetic only.
-- Adds telemetry tables, one trigger and monitoring functions, and replaces exactly two read functions with LINES ADDED
-- only (si_search_advertisers: the 0023 text; si_advertiser_history: the 0018 text): each successful request records its
-- request kind, execution path, exact fallback reason and duration, AFTER its audit (intent consumed, access log) and in
-- the same transaction. Telemetry never fails a read or a control: its writes run in a subtransaction whose error is
-- swallowed (SI_TELEMETRY_LOST warning). No query term, name, URL, ad content or reason text is stored anywhere.
-- Response documents, errors, pagination, grants, audit, availability, lock order and every other object are unchanged.
-- Down restores the exact 0025 catalog.

------------------------------------------------------------------------------------------
-- Telemetry (owner-only tables; append-only)
------------------------------------------------------------------------------------------
-- One row per SUCCESSFUL read (a failed read rolls back with its telemetry; failures: read_failures and expired intents).
-- No FK: telemetry must never fail or lock-order a read; read_intents / reader_access_log remain the audit of record.
CREATE TABLE si.read_path_events (
  intent_id        uuid PRIMARY KEY,
  request_kind     text NOT NULL CHECK (request_kind IN ('search', 'history')),
  principal        text NOT NULL CHECK (principal ~ '^si_reader_[a-z0-9_]{1,40}$'),
  source_id        text NOT NULL CHECK (source_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  path             text NOT NULL CHECK (path IN ('summary', 'observations')),
  fallback_reason  text CHECK (fallback_reason IN ('DRIFT', 'INCOMPLETE', 'DRIFT,INCOMPLETE', 'GUARD', 'NOT_APPLICABLE')),
  duration_us      bigint NOT NULL CHECK (duration_us >= 0),
  recorded_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((path = 'summary') = (fallback_reason IS NULL)),
  CHECK (request_kind = 'search' OR (path = 'observations' AND fallback_reason = 'NOT_APPLICABLE'))
);
CREATE INDEX read_path_events_by_time ON si.read_path_events (recorded_at);

-- Client-reported failure classification (the reader library, in its own transaction, for its OWN still-OPEN intent only).
-- Fixed codes; the server-side truth for a failed or abandoned read is its intent left OPEN past expiry (si_read_path_status).
CREATE TABLE si.read_failures (
  intent_id     uuid PRIMARY KEY,
  request_kind  text NOT NULL CHECK (request_kind IN ('search', 'history')),
  principal     text NOT NULL CHECK (principal ~ '^si_reader_[a-z0-9_]{1,40}$'),
  source_id     text NOT NULL CHECK (source_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  code          text NOT NULL CHECK (code IN ('BAD_ARGUMENT', 'BAD_CURSOR', 'NOT_AUTHORIZED', 'UNSAFE_SESSION', 'BUSY', 'ISOLATION', 'INTENT_INVALID', 'INTENT_UNCOMMITTED', 'INTENT_USED', 'INTENT_EXPIRED', 'INTENT_NOT_DURABLE', 'INTERNAL', 'SCAN_LIMIT', 'SOURCE_UNAVAILABLE', 'RESULT_TOO_LARGE', 'RESOURCE_LIMIT', 'IDENTITY_CONFLICT')),
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX read_failures_by_time ON si.read_failures (recorded_at);

-- One row per COMMITTED source control: how long it waited for the source lock (wall_clock_at, read by the 0001 trigger
-- right after FOR UPDATE, minus the start of the calling statement). A control refused by its lock_timeout rolls back:
-- live waits are reported by si_control_lock_waits().
CREATE TABLE si.source_control_timings (
  control_event_id      bigint PRIMARY KEY,
  source_id             text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('SUSPEND', 'LIFT', 'TERMINATE_RETENTION')),
  statement_started_at  timestamptz NOT NULL,
  decided_at            timestamptz NOT NULL,
  wait_ms               numeric NOT NULL CHECK (wait_ms >= 0),
  recorded_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX source_control_timings_by_time ON si.source_control_timings (recorded_at);

-- Client-reported REFUSED controls (a refusal rolls back, so the server cannot count it): the control client (si_rights_admin)
-- records a fixed code in its own transaction. Content-free: no reason or reference text.
CREATE TABLE si.source_control_failures (
  failure_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    text NOT NULL CHECK (source_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind         text NOT NULL CHECK (kind IN ('SUSPEND', 'LIFT', 'TERMINATE_RETENTION')),
  code         text NOT NULL CHECK (code IN ('LOCK_TIMEOUT', 'STATEMENT_TIMEOUT', 'ISOLATION', 'CLOCK_REGRESSION', 'COMPARE_AND_SET', 'BAD_ARGUMENT', 'OTHER')),
  recorded_by  text NOT NULL DEFAULT session_user,
  recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX source_control_failures_by_time ON si.source_control_failures (recorded_at);

CREATE FUNCTION si.trg_telemetry_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $telemetry_append_only$
BEGIN
  RAISE EXCEPTION 'SI_TELEMETRY_APPEND_ONLY: % is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $telemetry_append_only$;
CREATE TRIGGER trg_read_path_events_append_only BEFORE UPDATE OR DELETE ON si.read_path_events
FOR EACH ROW EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_read_path_events_no_truncate BEFORE TRUNCATE ON si.read_path_events
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_read_failures_append_only BEFORE UPDATE OR DELETE ON si.read_failures
FOR EACH ROW EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_read_failures_no_truncate BEFORE TRUNCATE ON si.read_failures
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_control_timings_append_only BEFORE UPDATE OR DELETE ON si.source_control_timings
FOR EACH ROW EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_control_timings_no_truncate BEFORE TRUNCATE ON si.source_control_timings
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_control_failures_append_only BEFORE UPDATE OR DELETE ON si.source_control_failures
FOR EACH ROW EXECUTE FUNCTION si.trg_telemetry_append_only();
CREATE TRIGGER trg_control_failures_no_truncate BEFORE TRUNCATE ON si.source_control_failures
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_telemetry_append_only();

-- Called by the two read functions (owner context) after their audit writes. Never raises.
CREATE FUNCTION si.si_record_read_path(p_kind text, p_principal text, p_source_id text, p_intent_id uuid, p_path text,
                                       p_fallback text, p_started timestamptz)
RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $record_read_path$
BEGIN
  BEGIN
    INSERT INTO si.read_path_events (intent_id, request_kind, principal, source_id, path, fallback_reason, duration_us)
    VALUES (p_intent_id, p_kind, p_principal, p_source_id, p_path, p_fallback,
            greatest(0, (extract(epoch FROM clock_timestamp() - p_started) * 1000000)::bigint));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'SI_TELEMETRY_LOST: read path event not recorded (%)', SQLSTATE;
  END;
END $record_read_path$;

-- AFTER INSERT on source_controls (fires after the 0001 BEFORE trigger took the lock and set wall_clock_at). Never raises.
CREATE FUNCTION si.trg_source_control_timing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $source_control_timing$
BEGIN
  BEGIN
    INSERT INTO si.source_control_timings (control_event_id, source_id, kind, statement_started_at, decided_at, wait_ms)
    VALUES (NEW.control_event_id, NEW.source_id, NEW.kind, statement_timestamp(), NEW.wall_clock_at,
            greatest(0, extract(epoch FROM NEW.wall_clock_at - statement_timestamp()) * 1000));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'SI_TELEMETRY_LOST: control timing not recorded (%)', SQLSTATE;
  END;
  RETURN NULL;
END $source_control_timing$;
CREATE TRIGGER trg_source_control_timing AFTER INSERT ON si.source_controls
FOR EACH ROW EXECUTE FUNCTION si.trg_source_control_timing();

------------------------------------------------------------------------------------------
-- The two read functions: the previous text with telemetry lines ADDED (nothing removed or edited)
------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION si.si_search_advertisers(p_source_id text, p_intent_id uuid, p_query text, p_networks text[],
  p_from timestamptz, p_to timestamptz, p_after text, p_after_inclusive boolean, p_limit int)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
SET work_mem = '4MB'
SET hash_mem_multiplier = 2
SET max_parallel_workers_per_gather = 0
SET jit = off
SET temp_file_limit = '256MB'
SET plan_cache_mode = force_custom_plan
AS $search$
DECLARE
  who text := session_user;
  problem text;
  q text;
  cur text;
  st record;
  candidates int;
  page jsonb;
  hits int;
  out_doc jsonb;
  bytes int;
  readable_runs uuid[];
  summary_ok boolean;                              -- 0023: the page was computed from the summaries
  summary_candidates bigint;
  cov record;
  fp text;
  max_candidates constant int := 200000;
  max_bytes constant int := 262144;                -- = the audit CHECK (0008/0009)
  t0 timestamptz := clock_timestamp();             -- 0026: request duration (content-free telemetry)
  fallback text;                                   -- 0026: why the observation path answered
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: reads require READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_source_id IS NULL OR p_source_id !~ '^[a-z0-9][a-z0-9-]{1,62}$' OR NOT si.si_reader_principal_ok(who) THEN
    RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  problem := coalesce(si.si_reader_session_problem(),
                      CASE WHEN current_setting('synchronous_commit') = 'off' THEN 'synchronous_commit' END);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'SI_READ_UNSAFE_SESSION: %', problem USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 OR p_query IS NULL OR length(p_query) > 300 OR p_after_inclusive IS NULL THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: limit 1-50, a query of at most 300 characters and an explicit inclusive flag are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  q := si.si_normalize_advertiser(p_query);
  IF q = '' THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: the normalized query is empty' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_after IS NOT NULL AND (p_after = '' OR length(p_after) > 18000) THEN               -- 18 x 1000: the largest normalized name
    RAISE EXCEPTION 'SI_READ_BAD_CURSOR: malformed page position' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM si.si_intelligence_check_args(p_networks, p_from, p_to);
  cur := si.si_intelligence_scope('search', p_source_id, ARRAY[p_query, array_to_string(p_networks, ','),
           si.si_intelligence_iso(p_from), si.si_intelligence_iso(p_to), p_after, p_after_inclusive::text]);

  -- The committed, crash-durable request record for exactly this request (0010 gate).
  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, p_limit);

  BEGIN
    PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id FOR SHARE;                -- rank 3
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g
                                 WHERE g.principal = who AND g.source_id = p_source_id AND g.revoked_at IS NULL
                                   AND g.purpose = 'INTERNAL_SYNTHETIC_EVALUATION') THEN
      RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO st FROM si.si_availability_state(p_source_id, who);
    IF st.available IS NOT TRUE THEN
      RAISE EXCEPTION 'SI_READ_SOURCE_UNAVAILABLE: %', array_to_string(st.reasons, ',') USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- 0018 (M4-P3.0): the readable runs, set-based (si_readable_runs: the si_evidence_readable predicate at ONE instant),
    -- before the page and under the same lock.
    readable_runs := si.si_readable_runs(p_source_id, p_from, p_to);

    -- 0023 (M4-P3.2): the page from the immutable summaries (0020) when the source is eligible; otherwise, or when the
    -- in-statement guard fails, the observation statement below (unchanged 0018 text), which is authoritative.
    --  * Eligibility, once per request: si_summary_coverage (every COMPLETED RETAINED/EMPTY run of the source has a status
    --    under the current normalizer fingerprint, and no drift is open).
    --  * Guard, in the SAME snapshot as the page: no open drift, and every readable run of this page has a status under the
    --    current fingerprint. A run's summary rows and status commit with its completion; they are removed only by a purge
    --    (excluded by the source lock held here), as STALE (another fingerprint) or under open drift (rebuild).
    --  * Content is trusted (contract B, trusted owner): the read path does not recompute it; si_verify_summaries does.
    -- Readability, period, networks, grant, availability, cursor, ordering, the observation cap and the byte bound are the
    -- observation path's, evaluated on the same readable runs.
    summary_ok := false;
    SELECT * INTO cov FROM si.si_summary_coverage(p_source_id);
    IF cov.eligible IS TRUE THEN
      fp := si.si_normalizer_fingerprint();
      WITH guard AS (
        SELECT NOT si.si_summary_drift_open(p_source_id)
               AND (SELECT count(*) FROM si.run_summary_status ss
                     WHERE ss.run_id = ANY (readable_runs) AND ss.source_id = p_source_id AND ss.normalizer = fp)
                   = cardinality(readable_runs) AS ok),
      hit AS MATERIALIZED (                                                     -- one row per matching identity: its observations
        SELECT i.identity_id, s.n
          FROM si.advertiser_identities i
         CROSS JOIN LATERAL (SELECT sum(s.observations) AS n FROM si.run_advertiser_summaries s
                              WHERE s.identity_id = i.identity_id AND s.source_id = p_source_id    -- index probe per identity
                                AND s.run_id = ANY (readable_runs)                    -- no join: a hashed membership test
                                AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))) s
         WHERE i.source_id = p_source_id AND i.normalizer = fp AND strpos(i.normalized_name, q) > 0 AND s.n IS NOT NULL
           AND (SELECT g.ok FROM guard g)),
      counted AS (SELECT coalesce(sum(h.n), 0)::bigint AS n FROM hit h),
      keys AS (                                                                 -- the page's identities, in cursor order
        SELECT h.identity_id, e.nn
          FROM hit h
         CROSS JOIN LATERAL (SELECT i.normalized_name AS nn FROM si.advertiser_identities i
                              WHERE i.identity_id = h.identity_id OFFSET 0) e          -- the name once per identity, by primary key
         WHERE p_after IS NULL OR e.nn COLLATE "C" > p_after OR (p_after_inclusive AND e.nn = p_after)
         ORDER BY e.nn COLLATE "C"
         LIMIT p_limit + 1),
      grouped AS (                                                              -- per page identity, nothing materialized
        SELECT k.nn, b.observations, d.distinct_ads, b.runs_with_evidence, b.first_observed_at, b.last_observed_at, b.networks, sp.names
          FROM keys k
         CROSS JOIN LATERAL (SELECT sum(s.observations)::int AS observations, count(DISTINCT s.run_id)::int AS runs_with_evidence,
                                    min(f.finished_at) AS first_observed_at, max(f.finished_at) AS last_observed_at,
                                    array_agg(DISTINCT s.network COLLATE "C" ORDER BY s.network COLLATE "C") AS networks
                               FROM si.run_advertiser_summaries s
                              CROSS JOIN LATERAL (SELECT r.finished_at FROM si.collection_runs r WHERE r.run_id = s.run_id OFFSET 0) f
                              WHERE s.identity_id = k.identity_id AND s.source_id = p_source_id
                                AND s.run_id = ANY (readable_runs)
                                AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))) b
         CROSS JOIN LATERAL (SELECT count(DISTINCT u.ad_id)::int AS distinct_ads           -- distinct ads = |union of ad_ids| (D1)
                               FROM si.run_advertiser_summaries s CROSS JOIN LATERAL unnest(s.ad_ids) AS u(ad_id)
                              WHERE s.identity_id = k.identity_id AND s.source_id = p_source_id
                                AND s.run_id = ANY (readable_runs)
                                AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))) d
         CROSS JOIN LATERAL (SELECT array_agg(DISTINCT u.nm COLLATE "C" ORDER BY u.nm COLLATE "C") AS names
                               FROM si.run_advertiser_summaries s CROSS JOIN LATERAL unnest(s.names) AS u(nm)
                              WHERE s.identity_id = k.identity_id AND s.source_id = p_source_id
                                AND s.run_id = ANY (readable_runs)
                                AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))) sp)
    SELECT (SELECT g.ok FROM guard g), (SELECT c.n FROM counted c),
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
             'normalized_name', g.nn, 'names', to_jsonb(g.names[1:10]), 'names_truncated', cardinality(g.names) > 10,
             'observations', g.observations, 'distinct_ads', g.distinct_ads, 'runs_with_evidence', g.runs_with_evidence,
             'first_observed_at', si.si_intelligence_iso(g.first_observed_at), 'last_observed_at', si.si_intelligence_iso(g.last_observed_at),
             'networks', to_jsonb(g.networks)) ORDER BY g.nn COLLATE "C"), '[]'::jsonb) FROM grouped g)
      INTO summary_ok, summary_candidates, page;
      summary_ok := coalesce(summary_ok, false);
      IF summary_ok THEN
        candidates := least(summary_candidates, max_candidates + 1)::int;
      END IF;
    END IF;
    RAISE DEBUG 'SI_READ_PATH %', CASE WHEN summary_ok THEN 'summary' ELSE 'observations' END;
    fallback := CASE WHEN summary_ok THEN NULL                              -- 0026: exact fallback reason
                     WHEN cov.eligible IS TRUE THEN 'GUARD'                     -- eligible, but the in-snapshot guard failed
                     ELSE array_to_string(cov.reasons, ',') END;                -- DRIFT, INCOMPLETE or DRIFT,INCOMPLETE

    IF summary_ok IS NOT TRUE THEN                                              -- the observation path (0018 text)

    WITH cand AS (
      SELECT si.si_normalize_advertiser(o.advertiser_name) AS nn, o.advertiser_name, o.network, o.native_ad_id, o.run_id,
             (SELECT r.finished_at FROM si.collection_runs r WHERE r.run_id = o.run_id) AS finished_at
        FROM si.observations o
       WHERE o.source_id = p_source_id AND o.run_id = ANY (readable_runs)                  -- no join: a hashed membership test
         AND (cardinality(p_networks) = 0 OR o.network = ANY (p_networks))
         AND strpos(si.si_normalize_advertiser(o.advertiser_name), q) > 0
       LIMIT max_candidates + 1),
    counted AS (SELECT count(*)::int AS n FROM cand),
    grouped AS (
      SELECT c.nn,
             count(*)::int AS observations,
             count(DISTINCT (c.network, c.native_ad_id))::int AS distinct_ads,
             count(DISTINCT c.run_id)::int AS runs_with_evidence,
             min(c.finished_at) AS first_observed_at, max(c.finished_at) AS last_observed_at,
             array_agg(DISTINCT c.network COLLATE "C" ORDER BY c.network COLLATE "C") AS networks,
             array_agg(DISTINCT c.advertiser_name COLLATE "C" ORDER BY c.advertiser_name COLLATE "C") AS names
        FROM cand c
       WHERE p_after IS NULL OR c.nn COLLATE "C" > p_after OR (p_after_inclusive AND c.nn = p_after)
       GROUP BY c.nn
       ORDER BY c.nn COLLATE "C"
       LIMIT p_limit + 1)
    SELECT (SELECT n FROM counted),
           coalesce(jsonb_agg(jsonb_build_object(
             'normalized_name', g.nn, 'names', to_jsonb(g.names[1:10]), 'names_truncated', cardinality(g.names) > 10,
             'observations', g.observations, 'distinct_ads', g.distinct_ads, 'runs_with_evidence', g.runs_with_evidence,
             'first_observed_at', si.si_intelligence_iso(g.first_observed_at), 'last_observed_at', si.si_intelligence_iso(g.last_observed_at),
             'networks', to_jsonb(g.networks)) ORDER BY g.nn COLLATE "C"), '[]'::jsonb)
      INTO candidates, page
      FROM grouped g;
    END IF;
    IF candidates > max_candidates THEN
      RAISE EXCEPTION 'SI_READ_SCAN_LIMIT: the request matches more than % observations; narrow it', max_candidates
        USING ERRCODE = 'program_limit_exceeded';
    END IF;
    hits := least(jsonb_array_length(page), p_limit);
    out_doc := jsonb_build_object('source_id', p_source_id, 'as_of', si.si_intelligence_iso(st.as_of), 'state_token', st.state_token,
      'normalized_query', q, 'hits', CASE WHEN jsonb_array_length(page) > p_limit THEN page - p_limit ELSE page END,
      'has_more', jsonb_array_length(page) > p_limit);
    -- Roll back this sub-block: its subtransaction, and with it the source lock, ends here.
    RAISE EXCEPTION USING ERRCODE = 'SIRLS', MESSAGE = 'SI_READ_RELEASE';
  EXCEPTION
    WHEN SQLSTATE 'SIRLS' THEN NULL;
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'SI_READ_BUSY: the source is being changed; retry' USING ERRCODE = 'lock_not_available';
    WHEN configuration_limit_exceeded THEN                                                  -- 53400: temp_file_limit
      RAISE EXCEPTION 'SI_READ_RESOURCE_LIMIT: the request needs more temporary storage than a read may use; narrow it'
        USING ERRCODE = 'program_limit_exceeded';
  END;

  bytes := octet_length(out_doc::text);
  IF bytes > max_bytes THEN
    RAISE EXCEPTION 'SI_READ_RESULT_TOO_LARGE: the page exceeds % bytes; request fewer results', max_bytes USING ERRCODE = 'program_limit_exceeded';
  END IF;
  BEGIN
    UPDATE si.read_intents i SET state = 'CONSUMED', rows_returned = hits, bytes_returned = bytes
     WHERE i.intent_id = p_intent_id AND i.state = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SI_READ_BUSY: the read intent is in use; retry' USING ERRCODE = 'lock_not_available';
  END;
  INSERT INTO si.reader_access_log (principal, source_id, rows_returned, bytes_returned, intent_id)
  VALUES (who, p_source_id, hits, bytes, p_intent_id);
  PERFORM si.si_record_read_path('search', who, p_source_id, p_intent_id,                  -- 0026: after the audit, same transaction
          CASE WHEN summary_ok THEN 'summary' ELSE 'observations' END, fallback, t0);
  RETURN out_doc;
END $search$;

CREATE OR REPLACE FUNCTION si.si_advertiser_history(p_source_id text, p_intent_id uuid, p_name text, p_networks text[],
  p_from timestamptz, p_to timestamptz, p_after text, p_limit int)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
SET work_mem = '4MB'
SET hash_mem_multiplier = 2
SET max_parallel_workers_per_gather = 0
SET jit = off
SET temp_file_limit = '256MB'
SET plan_cache_mode = force_custom_plan
AS $history$
DECLARE
  who text := session_user;
  problem text;
  nn text;
  nk bytea;
  m text[];
  a_fin timestamptz;
  a_run uuid;
  a_ord int;
  cur text;
  st record;
  summary jsonb;
  same_identity boolean;
  candidates int;
  page jsonb;
  released int;
  out_doc jsonb;
  bytes int;
  readable_runs uuid[];
  max_candidates constant int := 200000;
  max_bytes constant int := 262144;                -- = the audit CHECK (0008/0009)
  t0 timestamptz := clock_timestamp();             -- 0026: request duration (content-free telemetry)
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: reads require READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_source_id IS NULL OR p_source_id !~ '^[a-z0-9][a-z0-9-]{1,62}$' OR NOT si.si_reader_principal_ok(who) THEN
    RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  problem := coalesce(si.si_reader_session_problem(),
                      CASE WHEN current_setting('synchronous_commit') = 'off' THEN 'synchronous_commit' END);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'SI_READ_UNSAFE_SESSION: %', problem USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_name IS NULL OR length(p_name) > 1000 THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: limit 1-100 and a name of at most 1000 characters are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  nn := si.si_normalize_advertiser(p_name);
  IF nn = '' THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: the normalized name is empty' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  nk := sha256(convert_to(nn, 'UTF8'));                                                 -- index key only; identity is nn
  IF p_after IS NOT NULL THEN
    m := CASE WHEN length(p_after) <= 80 THEN regexp_match(p_after,
           '^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([0-9]{1,3})$') END;
    IF m IS NULL OR m[3]::int > 499 THEN
      RAISE EXCEPTION 'SI_READ_BAD_CURSOR: malformed page position' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    BEGIN
      a_fin := m[1]::timestamptz; a_run := m[2]::uuid; a_ord := m[3]::int;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'SI_READ_BAD_CURSOR: malformed page position' USING ERRCODE = 'invalid_parameter_value';
    END;
  END IF;
  PERFORM si.si_intelligence_check_args(p_networks, p_from, p_to);
  cur := si.si_intelligence_scope('history', p_source_id, ARRAY[p_name, array_to_string(p_networks, ','),
           si.si_intelligence_iso(p_from), si.si_intelligence_iso(p_to), p_after]);

  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, p_limit);

  BEGIN
    PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id FOR SHARE;                -- rank 3
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g
                                 WHERE g.principal = who AND g.source_id = p_source_id AND g.revoked_at IS NULL
                                   AND g.purpose = 'INTERNAL_SYNTHETIC_EVALUATION') THEN
      RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO st FROM si.si_availability_state(p_source_id, who);
    IF st.available IS NOT TRUE THEN
      RAISE EXCEPTION 'SI_READ_SOURCE_UNAVAILABLE: %', array_to_string(st.reasons, ',') USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- 0018 (M4-P3.0): the readable runs, set-based (si_readable_runs: the si_evidence_readable predicate at ONE instant),
    -- before the page and under the same lock.
    readable_runs := si.si_readable_runs(p_source_id, p_from, p_to);

    WITH mine AS (
      SELECT o.*, (SELECT r.finished_at FROM si.collection_runs r WHERE r.run_id = o.run_id) AS finished_at
        FROM si.observations o
       WHERE o.source_id = p_source_id AND si.si_advertiser_key(o.advertiser_name) = nk          -- selects by key (index)
         AND o.run_id = ANY (readable_runs)                                                    -- no join: a hashed membership test
         AND (cardinality(p_networks) = 0 OR o.network = ANY (p_networks))
       LIMIT max_candidates + 1),
    agg AS (
      SELECT count(*)::int AS n,
             count(DISTINCT (network, native_ad_id))::int AS distinct_ads,
             count(DISTINCT run_id)::int AS runs,
             min(finished_at) AS first_at, max(finished_at) AS last_at,
             min(coalesce(source_reported_first_seen, seen_at)) AS rep_first,
             max(coalesce(source_reported_last_seen, seen_at)) AS rep_last,
             array_agg(DISTINCT network COLLATE "C" ORDER BY network COLLATE "C") FILTER (WHERE network IS NOT NULL) AS networks,
             array_agg(DISTINCT advertiser_name COLLATE "C" ORDER BY advertiser_name COLLATE "C") FILTER (WHERE advertiser_name IS NOT NULL) AS names
        FROM mine),
    pg AS (
      SELECT * FROM mine
       WHERE p_after IS NULL OR (finished_at, run_id, ordinal) > (a_fin, a_run, a_ord)
       ORDER BY finished_at, run_id, ordinal
       LIMIT p_limit + 1)
    SELECT a.n,
           -- identity is the full normalized name: every distinct spelling selected by the key must normalize to it
           NOT EXISTS (SELECT 1 FROM unnest(a.names) AS u(nm) WHERE si.si_normalize_advertiser(u.nm) IS DISTINCT FROM nn),
           jsonb_build_object('observations', a.n, 'distinct_ads', a.distinct_ads, 'runs_with_evidence', a.runs,
             'first_observed_at', si.si_intelligence_iso(a.first_at), 'last_observed_at', si.si_intelligence_iso(a.last_at),
             'source_reported_first_seen', si.si_intelligence_iso(a.rep_first), 'source_reported_last_seen', si.si_intelligence_iso(a.rep_last),
             'networks', to_jsonb(coalesce(a.networks, '{}'::text[])), 'names', to_jsonb(coalesce(nb.kept, '{}'::text[])),
             'names_truncated', coalesce(cardinality(a.names), 0) > coalesce(cardinality(nb.kept), 0)),
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'run_id', p.run_id, 'ordinal', p.ordinal, 'collected_at', si.si_intelligence_iso(p.finished_at),
              'seen_at', si.si_intelligence_iso(p.seen_at), 'network', p.network, 'native_ad_id', p.native_ad_id,
              'advertiser_name', p.advertiser_name, 'title', p.title, 'source_url', p.source_url, 'content_sha256', p.content_sha256)
              ORDER BY p.finished_at, p.run_id, p.ordinal), '[]'::jsonb) FROM pg p)
      INTO candidates, same_identity, summary, page
      FROM agg a
      CROSS JOIN LATERAL (SELECT array_agg(z.nm ORDER BY z.i) AS kept                       -- first 50 spellings, at most 64 KiB
                            FROM (SELECT u.nm, u.i, sum(octet_length(to_jsonb(u.nm)::text) + 2) OVER (ORDER BY u.i) AS cum
                                    FROM unnest(a.names) WITH ORDINALITY AS u(nm, i)) z
                           WHERE z.i <= 50 AND z.cum <= 65536) nb;
    IF same_identity IS NOT TRUE THEN                                                -- a key collision: never merge identities
      RAISE EXCEPTION 'SI_READ_IDENTITY_CONFLICT: the advertiser key selects another normalized name' USING ERRCODE = 'data_exception';
    END IF;
    IF candidates > max_candidates THEN
      RAISE EXCEPTION 'SI_READ_SCAN_LIMIT: the request matches more than % observations; narrow it', max_candidates
        USING ERRCODE = 'program_limit_exceeded';
    END IF;
    released := least(jsonb_array_length(page), p_limit);
    out_doc := jsonb_build_object('source_id', p_source_id, 'as_of', si.si_intelligence_iso(st.as_of), 'state_token', st.state_token,
      'normalized_name', nn, 'summary', summary,
      'observations', CASE WHEN jsonb_array_length(page) > p_limit THEN page - p_limit ELSE page END,
      'next_after', CASE WHEN jsonb_array_length(page) > p_limit
                         THEN (page -> (p_limit - 1) ->> 'collected_at') || '|' || (page -> (p_limit - 1) ->> 'run_id') || '|' || (page -> (p_limit - 1) ->> 'ordinal') END);
    RAISE EXCEPTION USING ERRCODE = 'SIRLS', MESSAGE = 'SI_READ_RELEASE';
  EXCEPTION
    WHEN SQLSTATE 'SIRLS' THEN NULL;
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'SI_READ_BUSY: the source is being changed; retry' USING ERRCODE = 'lock_not_available';
    WHEN configuration_limit_exceeded THEN                                                  -- 53400: temp_file_limit
      RAISE EXCEPTION 'SI_READ_RESOURCE_LIMIT: the request needs more temporary storage than a read may use; narrow it'
        USING ERRCODE = 'program_limit_exceeded';
  END;

  bytes := octet_length(out_doc::text);
  IF bytes > max_bytes THEN
    RAISE EXCEPTION 'SI_READ_RESULT_TOO_LARGE: the page exceeds % bytes; request fewer results', max_bytes USING ERRCODE = 'program_limit_exceeded';
  END IF;
  BEGIN
    UPDATE si.read_intents i SET state = 'CONSUMED', rows_returned = released, bytes_returned = bytes
     WHERE i.intent_id = p_intent_id AND i.state = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SI_READ_BUSY: the read intent is in use; retry' USING ERRCODE = 'lock_not_available';
  END;
  INSERT INTO si.reader_access_log (principal, source_id, rows_returned, bytes_returned, intent_id)
  VALUES (who, p_source_id, released, bytes, p_intent_id);
  PERFORM si.si_record_read_path('history', who, p_source_id, p_intent_id, 'observations', 'NOT_APPLICABLE', t0);   -- 0026
  RETURN out_doc;
END $history$;

------------------------------------------------------------------------------------------
-- Client-reported failure label (si_reader): only the session's own intent, only while it is still OPEN (never consumed)
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_record_read_failure(p_intent_id uuid, p_kind text, p_code text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record_read_failure$
DECLARE
  who text := session_user;
  i record;
BEGIN
  IF NOT si.si_reader_principal_ok(who) THEN
    RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('search', 'history') OR p_code IS NULL OR p_code NOT IN ('BAD_ARGUMENT', 'BAD_CURSOR', 'NOT_AUTHORIZED', 'UNSAFE_SESSION', 'BUSY', 'ISOLATION', 'INTENT_INVALID', 'INTENT_UNCOMMITTED', 'INTENT_USED', 'INTENT_EXPIRED', 'INTENT_NOT_DURABLE', 'INTERNAL', 'SCAN_LIMIT', 'SOURCE_UNAVAILABLE', 'RESULT_TOO_LARGE', 'RESOURCE_LIMIT', 'IDENTITY_CONFLICT') THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: unknown request kind or failure code' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.principal, x.source_id, x.state INTO i FROM si.read_intents x WHERE x.intent_id = p_intent_id;
  IF NOT FOUND OR i.principal IS DISTINCT FROM who OR i.state <> 'OPEN' THEN
    RETURN false;                                                     -- not this session's failed intent: nothing recorded
  END IF;
  INSERT INTO si.read_failures (intent_id, request_kind, principal, source_id, code)
  VALUES (p_intent_id, p_kind, who, i.source_id, p_code) ON CONFLICT (intent_id) DO NOTHING;
  RETURN FOUND;
END $record_read_failure$;

-- Client-reported control refusal (si_rights_admin). Never changes a control; fixed codes only.
CREATE FUNCTION si.si_record_control_failure(p_source_id text, p_kind text, p_code text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record_control_failure$
BEGIN
  IF p_source_id IS NULL OR p_source_id !~ '^[a-z0-9][a-z0-9-]{1,62}$' OR p_kind IS NULL OR p_kind NOT IN ('SUSPEND', 'LIFT', 'TERMINATE_RETENTION')
     OR p_code IS NULL OR p_code NOT IN ('LOCK_TIMEOUT', 'STATEMENT_TIMEOUT', 'ISOLATION', 'CLOCK_REGRESSION', 'COMPARE_AND_SET', 'BAD_ARGUMENT', 'OTHER') THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: unknown source, control kind or failure code' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO si.source_control_failures (source_id, kind, code) VALUES (p_source_id, p_kind, p_code);
END $record_control_failure$;

------------------------------------------------------------------------------------------
-- Monitoring (si_monitor; SECURITY DEFINER, content-free: ids, codes, counts, durations, times)
------------------------------------------------------------------------------------------
-- Reads per source and kind in the window: paths, exact fallback reasons, latency, client-reported failures, and the
-- server-side count of the SOURCE's intents left OPEN past their 60 s expiry (failed or abandoned reads, classified or not;
-- intents carry no request kind, so this per-source value repeats on each kind's row).
CREATE FUNCTION si.si_read_path_status(p_window interval DEFAULT interval '1 hour')
RETURNS TABLE (source_id text, request_kind text, requests bigint, summary_path bigint, observation_path bigint,
               fallback_drift bigint, fallback_incomplete bigint, fallback_guard bigint, fallback_not_applicable bigint,
               p50_ms numeric, p95_ms numeric, max_ms numeric, failures_reported bigint, failure_codes jsonb,
               source_intents_expired_open bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $read_path_status$
  WITH e AS (SELECT * FROM si.read_path_events x WHERE x.recorded_at >= clock_timestamp() - p_window),
  f AS (SELECT x.* FROM si.read_failures x JOIN si.read_intents i ON i.intent_id = x.intent_id AND i.state = 'OPEN'
         WHERE x.recorded_at >= clock_timestamp() - p_window),
  k AS (SELECT e.source_id, e.request_kind FROM e UNION SELECT f.source_id, f.request_kind FROM f)
  SELECT k.source_id, k.request_kind,
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind),
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind AND e.path = 'summary'),
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind AND e.path = 'observations'),
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind AND e.fallback_reason IN ('DRIFT', 'DRIFT,INCOMPLETE')),
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind AND e.fallback_reason IN ('INCOMPLETE', 'DRIFT,INCOMPLETE')),
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind AND e.fallback_reason = 'GUARD'),
         (SELECT count(*) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind AND e.fallback_reason = 'NOT_APPLICABLE'),
         (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY e.duration_us) / 1000)::numeric, 3) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind),
         (SELECT round((percentile_cont(0.95) WITHIN GROUP (ORDER BY e.duration_us) / 1000)::numeric, 3) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind),
         (SELECT round(max(e.duration_us) / 1000.0, 3) FROM e WHERE e.source_id = k.source_id AND e.request_kind = k.request_kind),
         (SELECT count(*) FROM f WHERE f.source_id = k.source_id AND f.request_kind = k.request_kind),
         (SELECT coalesce(jsonb_object_agg(c.code, c.n), '{}'::jsonb) FROM (SELECT f.code, count(*) AS n FROM f
                  WHERE f.source_id = k.source_id AND f.request_kind = k.request_kind GROUP BY f.code) c),
         (SELECT count(*) FROM si.read_intents i WHERE i.source_id = k.source_id AND i.state = 'OPEN'
                  AND i.expires_at < clock_timestamp() AND i.created_at >= clock_timestamp() - p_window)
    FROM k ORDER BY 1, 2
$read_path_status$;

-- Verification health per source (content-free): last clean sweep and its age, the active sweep and its progress,
-- open drift, the latest terminal state, recent BUSY / TIMEOUT / other batch failures, clearance and rebuild evidence.
CREATE FUNCTION si.si_verification_health(p_window interval DEFAULT interval '1 hour')
RETURNS TABLE (source_id text, drift_open boolean, drift_detected_at timestamptz, last_clean_sweep_id bigint,
               last_clean_completed_at timestamptz, seconds_since_clean numeric, active_sweep_id bigint, active_phase text,
               active_runs_done int, active_scope_runs int, active_identities_done int, active_scope_identities int,
               active_last_batch_at timestamptz, latest_terminal_state text, latest_stale_reason text,
               recent_busy int, recent_timeouts int, recent_other_failures int, active_failures_since_last_batch int,
               last_clearance_at timestamptz, last_clearance_sweep_id bigint, last_rebuild_at timestamptz,
               rebuilds_since_drift int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $verification_health$
  SELECT s.source_id, si.si_summary_drift_open(s.source_id),
         (SELECT max(e.recorded_at) FROM si.summary_events e WHERE e.source_id = s.source_id AND e.kind = 'DRIFT_DETECTED'
            AND e.event_id > coalesce((SELECT max(c.event_id) FROM si.summary_events c WHERE c.source_id = s.source_id AND c.kind = 'DRIFT_CLEARED'), 0)),
         lc.sweep_id, lc.completed_at, round(extract(epoch FROM clock_timestamp() - lc.completed_at)::numeric, 1),
         a.sweep_id, a.phase, a.runs_verified + a.unverifiable_runs, a.scope_runs, a.identities_verified, a.scope_identities, a.last_batch_at,
         lt.state, lt.stale_reason,
         (SELECT count(*)::int FROM si.summary_sweep_failures f JOIN si.summary_sweeps w ON w.sweep_id = f.sweep_id
           WHERE w.source_id = s.source_id AND f.code = 'BUSY' AND f.recorded_at >= clock_timestamp() - p_window),
         (SELECT count(*)::int FROM si.summary_sweep_failures f JOIN si.summary_sweeps w ON w.sweep_id = f.sweep_id
           WHERE w.source_id = s.source_id AND f.code = 'TIMEOUT' AND f.recorded_at >= clock_timestamp() - p_window),
         (SELECT count(*)::int FROM si.summary_sweep_failures f JOIN si.summary_sweeps w ON w.sweep_id = f.sweep_id
           WHERE w.source_id = s.source_id AND f.code NOT IN ('BUSY', 'TIMEOUT') AND f.recorded_at >= clock_timestamp() - p_window),
         (SELECT count(*)::int FROM si.summary_sweep_failures f WHERE f.sweep_id = a.sweep_id AND f.seq = a.batches + 1),
         cl.cleared_at, cl.sweep_id,
         (SELECT max(e.recorded_at) FROM si.summary_events e WHERE e.source_id = s.source_id AND e.kind = 'REBUILT'),
         (SELECT count(*)::int FROM si.summary_events e WHERE e.source_id = s.source_id AND e.kind = 'REBUILT'
            AND e.event_id > coalesce((SELECT max(c.event_id) FROM si.summary_events c WHERE c.source_id = s.source_id AND c.kind = 'DRIFT_CLEARED'), 0))
    FROM si.sources s
    LEFT JOIN LATERAL (SELECT w.sweep_id, w.completed_at FROM si.summary_sweeps w WHERE w.source_id = s.source_id AND w.state = 'COMPLETED_CLEAN'
                        ORDER BY w.completed_at DESC LIMIT 1) lc ON true
    LEFT JOIN LATERAL (SELECT w.* FROM si.summary_sweeps w WHERE w.source_id = s.source_id AND w.state = 'IN_PROGRESS') a ON true
    LEFT JOIN LATERAL (SELECT w.state, w.stale_reason FROM si.summary_sweeps w WHERE w.source_id = s.source_id AND w.state <> 'IN_PROGRESS'
                        ORDER BY w.sweep_id DESC LIMIT 1) lt ON true
    LEFT JOIN LATERAL (SELECT d.cleared_at, d.sweep_id FROM si.summary_drift_clearances d WHERE d.source_id = s.source_id
                        ORDER BY d.event_id DESC LIMIT 1) cl ON true
   ORDER BY 1
$verification_health$;

-- Committed source controls in the window: lock wait (ms) per source and kind, and how many exceeded the budget.
CREATE FUNCTION si.si_control_latency_status(p_window interval DEFAULT interval '24 hours', p_budget_ms numeric DEFAULT 5000)
RETURNS TABLE (source_id text, kind text, controls bigint, p50_wait_ms numeric, p95_wait_ms numeric, max_wait_ms numeric,
               over_budget bigint, refused bigint, refusal_codes jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $control_latency_status$
  WITH t AS (SELECT * FROM si.source_control_timings x WHERE x.recorded_at >= clock_timestamp() - p_window),
       f AS (SELECT * FROM si.source_control_failures x WHERE x.recorded_at >= clock_timestamp() - p_window),
       k AS (SELECT t.source_id, t.kind FROM t UNION SELECT f.source_id, f.kind FROM f)
  SELECT k.source_id, k.kind,
         (SELECT count(*) FROM t WHERE t.source_id = k.source_id AND t.kind = k.kind),
         (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.wait_ms)::numeric, 3) FROM t WHERE t.source_id = k.source_id AND t.kind = k.kind),
         (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY t.wait_ms)::numeric, 3) FROM t WHERE t.source_id = k.source_id AND t.kind = k.kind),
         (SELECT round(max(t.wait_ms), 3) FROM t WHERE t.source_id = k.source_id AND t.kind = k.kind),
         (SELECT count(*) FILTER (WHERE t.wait_ms > p_budget_ms) FROM t WHERE t.source_id = k.source_id AND t.kind = k.kind),
         (SELECT count(*) FROM f WHERE f.source_id = k.source_id AND f.kind = k.kind),
         (SELECT coalesce(jsonb_object_agg(c.code, c.n), '{}'::jsonb) FROM (SELECT f.code, count(*) AS n FROM f
                  WHERE f.source_id = k.source_id AND f.kind = k.kind GROUP BY f.code) c)
    FROM k ORDER BY 1, 2
$control_latency_status$;

-- Live lock waits in this database (pg_locks is readable by every role; no pg_read_all_stats needed): each waiting
-- backend's role, how long it has waited (waitstart), what it waits for, and its blockers' roles. A waiting si_rights_admin
-- is an emergency control in flight. Transaction ages and states of other roles are NOT visible without
-- pg_read_all_stats (docs §19.4).
CREATE FUNCTION si.si_control_lock_waits()
RETURNS TABLE (waiter_pid int, waiter_role text, wait_ms numeric, lock_type text, on_sources boolean, blocker_pids int[], blocker_roles text[])
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $control_lock_waits$
  SELECT l.pid, a.usename::text, round((extract(epoch FROM clock_timestamp() - min(l.waitstart)) * 1000)::numeric, 1),
         min(l.locktype),
         bool_or(l.relation = 'si.sources'::regclass)                           -- waiting on the table, or on a row of it:
           OR EXISTS (SELECT 1 FROM pg_locks t WHERE t.pid = l.pid AND t.locktype = 'tuple' AND t.relation = 'si.sources'::regclass),
         pg_blocking_pids(l.pid),
         ARRAY(SELECT b.usename::text FROM pg_stat_activity b WHERE b.pid = ANY (pg_blocking_pids(l.pid)) ORDER BY b.pid)
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE NOT l.granted AND l.waitstart IS NOT NULL AND a.datname = current_database()
   GROUP BY l.pid, a.usename ORDER BY 3 DESC
$control_lock_waits$;

-- The alerting contract (docs §19.5): deterministic rules over the functions above, every threshold a parameter.
-- Returns one row per firing alert; no row = no alert. Nothing is delivered anywhere: an external scheduler must poll it.
CREATE FUNCTION si.si_operational_alerts(
  p_max_clean_age       interval DEFAULT interval '24 hours',
  p_window              interval DEFAULT interval '1 hour',
  p_fallback_min        int      DEFAULT 20,
  p_fallback_ratio      numeric  DEFAULT 0.5,
  p_failure_max         int      DEFAULT 3,
  p_control_budget_ms   numeric  DEFAULT 5000,
  p_control_window      interval DEFAULT interval '24 hours',
  p_reader_p95_ms       numeric  DEFAULT 400,
  p_reader_min          int      DEFAULT 20)
RETURNS TABLE (alert text, source_id text, observed numeric, threshold numeric)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $operational_alerts$
  WITH h AS (SELECT * FROM si.si_verification_health(p_window)),
       r AS (SELECT * FROM si.si_read_path_status(p_window)),
       c AS (SELECT * FROM si.si_control_latency_status(p_control_window, p_control_budget_ms))
  SELECT 'DRIFT_OPEN'::text, h.source_id, 1::numeric, 0::numeric FROM h WHERE h.drift_open
  UNION ALL
  SELECT 'VERIFICATION_OVERDUE', h.source_id, h.seconds_since_clean, extract(epoch FROM p_max_clean_age)::numeric FROM h
   WHERE h.last_clean_completed_at IS NULL OR h.seconds_since_clean > extract(epoch FROM p_max_clean_age)
  UNION ALL
  SELECT 'VERIFICATION_FAILING', h.source_id, (h.recent_busy + h.recent_timeouts + h.recent_other_failures)::numeric, p_failure_max::numeric FROM h
   WHERE h.recent_busy + h.recent_timeouts + h.recent_other_failures >= p_failure_max
  UNION ALL
  SELECT 'VERIFICATION_STALLED', h.source_id, NULL::numeric, NULL::numeric FROM h WHERE h.latest_terminal_state IN ('INCOMPLETE', 'STALE')
     AND h.active_sweep_id IS NULL
     AND (h.last_clean_completed_at IS NULL OR h.last_clean_completed_at < (SELECT max(w.completed_at) FROM si.summary_sweeps w WHERE w.source_id = h.source_id))
  UNION ALL
  SELECT 'PERSISTENT_FALLBACK', r.source_id, round(r.observation_path::numeric / r.requests, 3), p_fallback_ratio FROM r
   WHERE r.request_kind = 'search' AND r.requests >= p_fallback_min AND r.observation_path::numeric / r.requests >= p_fallback_ratio
  UNION ALL
  SELECT 'READER_LATENCY', r.source_id, r.p95_ms, p_reader_p95_ms FROM r WHERE r.requests >= p_reader_min AND r.p95_ms > p_reader_p95_ms
  UNION ALL
  SELECT 'CONTROL_DEADLINE_BREACH', c.source_id, c.max_wait_ms, p_control_budget_ms FROM c WHERE c.over_budget > 0
  UNION ALL
  SELECT 'CONTROL_REFUSED', c.source_id, c.refused::numeric, 0::numeric FROM c WHERE c.refused > 0
  UNION ALL
  SELECT 'CONTROL_WAITING', NULL, w.wait_ms, p_control_budget_ms FROM si.si_control_lock_waits() w
   WHERE w.waiter_role = 'si_rights_admin' AND w.wait_ms > p_control_budget_ms
  ORDER BY 1, 2
$operational_alerts$;

------------------------------------------------------------------------------------------
-- Privileges: tables owner-only; si_monitor executes the monitoring functions; si_reader only its failure label
------------------------------------------------------------------------------------------
REVOKE ALL ON si.read_path_events, si.read_failures, si.source_control_timings, si.source_control_failures FROM PUBLIC;
REVOKE ALL ON FUNCTION si.trg_telemetry_append_only(), si.si_record_read_path(text, text, text, uuid, text, text, timestamptz),
  si.trg_source_control_timing(), si.si_record_read_failure(uuid, text, text), si.si_record_control_failure(text, text, text),
  si.si_read_path_status(interval),
  si.si_verification_health(interval), si.si_control_latency_status(interval, numeric), si.si_control_lock_waits(),
  si.si_operational_alerts(interval, interval, int, numeric, int, numeric, interval, numeric, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_record_read_failure(uuid, text, text) TO si_reader;
GRANT EXECUTE ON FUNCTION si.si_record_control_failure(text, text, text) TO si_rights_admin;
GRANT EXECUTE ON FUNCTION si.si_read_path_status(interval), si.si_verification_health(interval),
  si.si_control_latency_status(interval, numeric), si.si_control_lock_waits(),
  si.si_operational_alerts(interval, interval, int, numeric, int, numeric, interval, numeric, int) TO si_monitor;
