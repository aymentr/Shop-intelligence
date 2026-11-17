-- B-002 migration 0023: M4-P3.2 — summary-backed advertiser search (synthetic only). Contract: docs/b002-m4-intelligence.md §16.
-- Replaces exactly si_search_advertisers (the 0018 text with one block ADDED; nothing of 0018 is removed or edited):
-- when the source is eligible for summary-backed reads, the page is computed from the immutable M4-P3.1 summaries (0020)
-- over the SAME readable runs; otherwise the unchanged 0018 observation statement computes it. The response document,
-- its ordering, cursor, bounds, errors, request audit, grant check, availability check, durability gate and lock order are
-- the 0018 ones. No table, column, index, grant or stored decision. si_advertiser_history is unchanged (§16.2: its response
-- carries per-observation rows and source-reported first/last seen, which summaries do not hold; it is already selected by
-- the advertiser-key index). Down restores the exact 0022 catalog.

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
      hit AS MATERIALIZED (                                                     -- every matching summary row: identity and count only
        SELECT i.identity_id, s.observations
          FROM si.advertiser_identities i
         CROSS JOIN LATERAL (SELECT s.observations FROM si.run_advertiser_summaries s
                              WHERE s.identity_id = i.identity_id AND s.source_id = p_source_id
                                AND s.run_id = ANY (readable_runs)                    -- no join: a hashed membership test
                                AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))
                             OFFSET 0) s                                              -- correlated index probe per identity
         WHERE i.source_id = p_source_id AND i.normalizer = fp AND strpos(i.normalized_name, q) > 0
           AND (SELECT g.ok FROM guard g)),
      counted AS (SELECT coalesce(sum(h.observations), 0)::bigint AS n FROM hit h),
      keys AS (                                                                 -- the page's identities, in cursor order
        SELECT d.identity_id, e.nn
          FROM (SELECT DISTINCT h.identity_id FROM hit h) d
         CROSS JOIN LATERAL (SELECT i.normalized_name AS nn FROM si.advertiser_identities i
                              WHERE i.identity_id = d.identity_id OFFSET 0) e          -- the name once per identity, by primary key
         WHERE p_after IS NULL OR e.nn COLLATE "C" > p_after OR (p_after_inclusive AND e.nn = p_after)
         ORDER BY e.nn COLLATE "C"
         LIMIT p_limit + 1),
      prow AS MATERIALIZED (                                                    -- their summary rows, arrays included
        SELECT k.identity_id, s.run_id, s.network, s.observations, s.ad_ids, s.names,
               (SELECT r.finished_at FROM si.collection_runs r WHERE r.run_id = s.run_id) AS finished_at
          FROM keys k
         CROSS JOIN LATERAL (SELECT s.run_id, s.network, s.observations, s.ad_ids, s.names FROM si.run_advertiser_summaries s
                              WHERE s.identity_id = k.identity_id AND s.source_id = p_source_id
                                AND s.run_id = ANY (readable_runs)
                                AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))
                             OFFSET 0) s),
      base AS (
        SELECT p.identity_id,
               sum(p.observations)::int AS observations,
               count(DISTINCT p.run_id)::int AS runs_with_evidence,
               min(p.finished_at) AS first_observed_at, max(p.finished_at) AS last_observed_at,
               array_agg(DISTINCT p.network COLLATE "C" ORDER BY p.network COLLATE "C") AS networks
          FROM prow p GROUP BY p.identity_id),
      ads AS (                                                                  -- distinct ads = |union of ad_ids| (D1)
        SELECT p.identity_id, count(DISTINCT u.ad_id)::int AS distinct_ads
          FROM prow p CROSS JOIN LATERAL unnest(p.ad_ids) AS u(ad_id) GROUP BY p.identity_id),
      spellings AS (
        SELECT p.identity_id, array_agg(DISTINCT u.nm COLLATE "C" ORDER BY u.nm COLLATE "C") AS names
          FROM prow p CROSS JOIN LATERAL unnest(p.names) AS u(nm) GROUP BY p.identity_id),
      grouped AS (
        SELECT k.nn, b.observations, a.distinct_ads, b.runs_with_evidence, b.first_observed_at, b.last_observed_at,
               b.networks, sp.names
          FROM keys k JOIN base b ON b.identity_id = k.identity_id JOIN ads a ON a.identity_id = k.identity_id
          JOIN spellings sp ON sp.identity_id = k.identity_id)
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
  RETURN out_doc;
END $search$;

