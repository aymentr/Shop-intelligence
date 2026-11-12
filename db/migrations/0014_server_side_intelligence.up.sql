-- B-002 migration 0014: M4-P2 — server-side audited advertiser search and history (synthetic only).
-- Contract: docs/b002-m4-intelligence.md §11. Migrations 0001-0013 unchanged; no existing function is modified.
--
-- Replaces the library's client-side scan (every readable record of a source, at most 5,000, paged through
-- si_read_evidence) with two reader functions that compute the result in the database, under the same boundary:
--   si_search_advertisers  one source: advertisers whose normalized name contains the normalized query;
--   si_advertiser_history  one source, one normalized name: summary + keyset-paged observations with provenance.
--
-- Gate (each call, like si_read_evidence / si_read_source_status / si_read_source_availability):
--   - dedicated reader principal, READ COMMITTED, reader session checks (synchronous_commit <> off included);
--   - a committed, crash-durable read intent of this login (0010 gate via si_claim_read_intent) whose audited scope
--     binds the COMPLETE request: 'v1|<source>|search|<sha256 of the canonical request>' (or '|history|'), limit = the
--     page size. The canonical request (si_intelligence_scope) is every argument, length-prefixed in UTF-8 bytes, so
--     no two different requests share a scope: query or name, networks, period, page position and page size. An
--     intent for one request cannot release another, and no other reader function accepts these scopes;
--   - under the source lock (FOR SHARE, rank 3, released before return): the active grant (NOT_AUTHORIZED before any
--     other fact), then the source's availability (the 0013 predicate, reasons and keyed state token, via
--     si_availability_state). Unavailable -> SI_READ_SOURCE_UNAVAILABLE with the fixed reason codes (granted readers
--     only), never an empty result;
--   - evidence: only runs for which si_evidence_readable(run) is true (VALID verdict, retention, controls, rights,
--     networks: the policy of every evidence page), and only their observations;
--   - bounds: page size 1-50 (search) / 1-100 (history); at most 200,000 candidate observations per call, otherwise
--     SI_READ_SCAN_LIMIT; response at most 1 MiB, otherwise SI_READ_RESULT_TOO_LARGE; at most 10 spellings per hit
--     (names_truncated flag). Nothing is retried inside;
--   - the intent is consumed and a completion row written (rows = hits or observations released, bytes).
--
-- Identity: an advertiser is (source, si_normalize_advertiser(name)). Normalization is done here, authoritatively
-- (NFKC with this server's Unicode tables, trim and collapse of the JavaScript \s whitespace set, lower-casing with the
-- ICU root locale). Results are never merged across sources (each call is one source). Ordering and keysets use
-- COLLATE "C" (code point order), so pages are deterministic and independent of the database collation.
-- Consistency: each page is computed in one statement under the source lock (consistent within the page). Pages are
-- separate requests: no snapshot spans pages (docs §11); each page returns the state token so a client can refuse a
-- change of availability between pages.

------------------------------------------------------------------------------------------
-- Normalization (owner-only; IMMUTABLE for the expression index. A PostgreSQL or ICU upgrade that changes Unicode
-- tables requires REINDEX INDEX si.observations_by_source_advertiser).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_normalize_advertiser(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $normalize$
  SELECT lower(regexp_replace(regexp_replace(normalize(p_name, NFKC),
           '^[\t\n\u000b\f\r    -     　﻿]+|[\t\n\u000b\f\r    -     　﻿]+$', '', 'g'),
           '[\t\n\u000b\f\r    -     　﻿]+', ' ', 'g') COLLATE "und-x-icu")
$normalize$;

CREATE INDEX observations_by_source_advertiser ON si.observations (source_id, si.si_normalize_advertiser(advertiser_name));

------------------------------------------------------------------------------------------
-- Canonical request scope (owner-only). Every field is '<UTF-8 byte length>:<value>' or 'N' (NULL), joined by '|'.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_intelligence_scope(p_kind text, p_source_id text, p_fields text[]) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $scope$
  SELECT 'v1|' || p_source_id || '|' || p_kind || '|' || encode(sha256(convert_to(
           (SELECT string_agg(CASE WHEN f IS NULL THEN 'N' ELSE octet_length(convert_to(f, 'UTF8'))::text || ':' || f END, '|' ORDER BY i)
              FROM unnest(p_fields) WITH ORDINALITY AS u(f, i)), 'UTF8')), 'hex')
$scope$;

------------------------------------------------------------------------------------------
-- Availability state under the caller's lock (owner-only; SECURITY INVOKER). The 0013 predicate, reasons and keyed
-- token, unchanged: for the same reader and state it returns exactly the token si_read_source_availability returns.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_availability_state(p_source_id text, p_who text,
  OUT available boolean, OUT reasons text[], OUT state_token text, OUT as_of timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $availability_state$
DECLARE
  pred boolean;
  cs record;
BEGIN
  SELECT s.evidence_kind = 'SYNTHETIC'
     AND (s.retired_at IS NULL OR n.t + si.si_publish_margin() < s.retired_at)
     AND NOT si.si_source_suspended(s.source_id)
     AND EXISTS (SELECT 1 FROM si.rights_versions cur_v
                  WHERE cur_v.source_id = s.source_id AND cur_v.effective_from <= n.t
                    AND cur_v.version = (SELECT max(m.version) FROM si.rights_versions m
                                          WHERE m.source_id = s.source_id AND m.effective_from <= n.t)
                    AND cur_v.evaluation = 'ALLOWED' AND cur_v.retain = 'ALLOWED'
                    AND NOT si.si_retention_terminated(s.source_id, cur_v.version)
                    AND n.t + si.si_publish_margin() < si.si_window_end(cur_v.rights_version_id))
    INTO pred
    FROM si.sources s CROSS JOIN (SELECT clock_timestamp() AS t) n
   WHERE s.source_id = p_source_id;
  SELECT src.evidence_kind, src.retired_at, src.xmin::text AS row_version, n.t,
         (SELECT c.kind FROM si.source_controls c WHERE c.source_id = src.source_id ORDER BY c.control_seq DESC LIMIT 1) AS last_kind,
         (SELECT max(c.control_seq) FROM si.source_controls c WHERE c.source_id = src.source_id) AS last_seq,
         v.rights_version_id AS cur_id, v.version AS cur_version, v.evaluation AS cur_evaluation, v.retain AS cur_retain,
         least(coalesce(v.expires_at, 'infinity'::timestamptz),
               coalesce((SELECT nx.effective_from FROM si.rights_versions nx
                          WHERE nx.source_id = src.source_id AND nx.version = v.version + 1), 'infinity'::timestamptz)) AS cur_valid_until
    INTO cs
    FROM si.sources src
    CROSS JOIN (SELECT clock_timestamp() AS t) n
    LEFT JOIN LATERAL (SELECT rv.* FROM si.rights_versions rv
                        WHERE rv.source_id = src.source_id AND rv.effective_from <= n.t
                        ORDER BY rv.version DESC LIMIT 1) v ON true
   WHERE src.source_id = p_source_id;
  as_of := cs.t;
  reasons := array_remove(ARRAY[
    CASE WHEN cs.retired_at IS NOT NULL AND NOT (cs.t + si.si_publish_margin() < cs.retired_at) THEN 'RETIRED' END,
    CASE WHEN cs.last_kind = 'TERMINATE_RETENTION'
              OR (cs.cur_version IS NOT NULL AND si.si_retention_terminated(p_source_id, cs.cur_version)) THEN 'TERMINATED' END,
    CASE WHEN cs.last_kind = 'SUSPEND' THEN 'SUSPENDED' END,
    CASE WHEN cs.cur_id IS NULL OR cs.cur_evaluation IS DISTINCT FROM 'ALLOWED'
              OR NOT (cs.t + si.si_publish_margin() < cs.cur_valid_until) THEN 'RIGHTS_RESTRICTED' END,
    CASE WHEN cs.cur_id IS NOT NULL AND cs.cur_retain IS DISTINCT FROM 'ALLOWED' THEN 'RETENTION_RESTRICTED' END,
    CASE WHEN cs.evidence_kind IS DISTINCT FROM 'SYNTHETIC' THEN 'NOT_SYNTHETIC' END
  ]::text[], NULL);
  IF pred IS NOT TRUE AND cardinality(reasons) = 0 THEN reasons := ARRAY['UNAVAILABLE']; END IF;
  available := pred IS TRUE AND cardinality(reasons) = 0;
  state_token := left(si.si_availability_mac(concat_ws('|', 'v2', p_who, p_source_id, cs.row_version,
                   coalesce(cs.last_seq::text, '-'), coalesce(cs.cur_id::text, '-'))), 32);
END $availability_state$;

------------------------------------------------------------------------------------------
-- Shared argument checks (owner-only): networks canonical (sorted, unique, allowed), period [from, to) at most 366 days
-- with millisecond precision, and the ISO form used in scopes.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_intelligence_iso(p_t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $iso$
  SELECT to_char(p_t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$iso$;

CREATE FUNCTION si.si_intelligence_check_args(p_networks text[], p_from timestamptz, p_to timestamptz) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $check_args$
BEGIN
  IF p_networks IS NULL OR array_ndims(p_networks) > 1 OR cardinality(p_networks) > 5
     OR array_position(p_networks, NULL) IS NOT NULL
     OR NOT (p_networks <@ ARRAY['META','TIKTOK','GOOGLE','PINTEREST','OTHER']::text[])
     OR p_networks IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT x COLLATE "C" ORDER BY x COLLATE "C"), '{}'::text[]) FROM unnest(p_networks) x) THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: networks must be a sorted, duplicate-free list of supported networks' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_from IS NULL) <> (p_to IS NULL)
     OR (p_from IS NOT NULL AND (p_from >= p_to OR p_to - p_from > interval '366 days'
                                 OR p_from <> date_trunc('milliseconds', p_from) OR p_to <> date_trunc('milliseconds', p_to))) THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: the period must be [from, to) with from < to, at most 366 days, millisecond precision'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END $check_args$;

------------------------------------------------------------------------------------------
-- Advertiser search (one source).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_search_advertisers(p_source_id text, p_intent_id uuid, p_query text, p_networks text[],
  p_from timestamptz, p_to timestamptz, p_after text, p_after_inclusive boolean, p_limit int)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
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
  max_candidates constant int := 200000;
  max_bytes constant int := 1048576;
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
  IF p_after IS NOT NULL AND (p_after = '' OR length(p_after) > 1000) THEN
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

    WITH readable AS (
      SELECT r.run_id, r.finished_at
        FROM si.collection_runs r
       WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
         AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at < p_to))
         AND si.si_evidence_readable(r.run_id)),
    cand AS (
      SELECT si.si_normalize_advertiser(o.advertiser_name) AS nn, o.advertiser_name, o.network, o.native_ad_id, o.run_id, rd.finished_at
        FROM readable rd JOIN si.observations o ON o.run_id = rd.run_id
       WHERE o.source_id = p_source_id
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

------------------------------------------------------------------------------------------
-- Advertiser history (one source, one normalized name).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_advertiser_history(p_source_id text, p_intent_id uuid, p_name text, p_networks text[],
  p_from timestamptz, p_to timestamptz, p_after text, p_limit int)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $history$
DECLARE
  who text := session_user;
  problem text;
  nn text;
  m text[];
  a_fin timestamptz;
  a_run uuid;
  a_ord int;
  cur text;
  st record;
  summary jsonb;
  candidates int;
  page jsonb;
  released int;
  out_doc jsonb;
  bytes int;
  max_candidates constant int := 200000;
  max_bytes constant int := 1048576;
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
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_name IS NULL OR length(p_name) > 300 THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: limit 1-100 and a name of at most 300 characters are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  nn := si.si_normalize_advertiser(p_name);
  IF nn = '' THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: the normalized name is empty' USING ERRCODE = 'invalid_parameter_value';
  END IF;
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

    WITH readable AS (
      SELECT r.run_id, r.finished_at
        FROM si.collection_runs r
       WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
         AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at < p_to))
         AND si.si_evidence_readable(r.run_id)),
    mine AS (
      SELECT o.*, rd.finished_at
        FROM si.observations o JOIN readable rd ON rd.run_id = o.run_id
       WHERE o.source_id = p_source_id AND si.si_normalize_advertiser(o.advertiser_name) = nn
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
           jsonb_build_object('observations', a.n, 'distinct_ads', a.distinct_ads, 'runs_with_evidence', a.runs,
             'first_observed_at', si.si_intelligence_iso(a.first_at), 'last_observed_at', si.si_intelligence_iso(a.last_at),
             'source_reported_first_seen', si.si_intelligence_iso(a.rep_first), 'source_reported_last_seen', si.si_intelligence_iso(a.rep_last),
             'networks', to_jsonb(coalesce(a.networks, '{}'::text[])), 'names', to_jsonb(coalesce(a.names[1:50], '{}'::text[])),
             'names_truncated', coalesce(cardinality(a.names) > 50, false)),
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'run_id', p.run_id, 'ordinal', p.ordinal, 'collected_at', si.si_intelligence_iso(p.finished_at),
              'seen_at', si.si_intelligence_iso(p.seen_at), 'network', p.network, 'native_ad_id', p.native_ad_id,
              'advertiser_name', p.advertiser_name, 'title', p.title, 'source_url', p.source_url, 'content_sha256', p.content_sha256)
              ORDER BY p.finished_at, p.run_id, p.ordinal), '[]'::jsonb) FROM pg p)
      INTO candidates, summary, page
      FROM agg a;
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
  RETURN out_doc;
END $history$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC. si_reader gains EXECUTE on the two reader functions only; every helper is owner-only.
------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION si.si_normalize_advertiser(text), si.si_intelligence_scope(text, text, text[]),
  si.si_availability_state(text, text), si.si_intelligence_iso(timestamptz), si.si_intelligence_check_args(text[], timestamptz, timestamptz),
  si.si_search_advertisers(text, uuid, text, text[], timestamptz, timestamptz, text, boolean, int),
  si.si_advertiser_history(text, uuid, text, text[], timestamptz, timestamptz, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_search_advertisers(text, uuid, text, text[], timestamptz, timestamptz, text, boolean, int),
  si.si_advertiser_history(text, uuid, text, text[], timestamptz, timestamptz, text, int) TO si_reader;
