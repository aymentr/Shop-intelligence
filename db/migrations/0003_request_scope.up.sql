-- B-002 migration 0003: Milestone 3, part 1 — request-scope foundation (FD7 option C).
-- Contract: docs/b002-m3-design.md section 4.2.
--
-- A scoped T1 wrapper verifies that the v1 request hash binds the source, evidence kind,
-- network set and fixture hash, calls the UNCHANGED si.si_begin_run with exactly the same
-- network array, and records that array as the run's request scope when (and only when) a new
-- RUNNING attempt was created. Runs started through plain si_begin_run have no scope and stay
-- EMPTY-only. No ads, observations, non-empty completion or content read exist here.
-- Runs as si_owner with search_path = pg_catalog, pg_temp (runner); everything is qualified.

------------------------------------------------------------------------------------------
-- v1 hashing, reproduced from src/persistence/request-hash.ts (frozen; not modified).
-- Canonical JSON: object keys sorted, no white space, strings NFC-normalized, JSON string
-- escaping as JSON.stringify. Fail-closed restrictions where an exact reproduction is not
-- guaranteed: object keys must be printable ASCII (JavaScript sorts keys by UTF-16 code unit,
-- PostgreSQL "C" order is by code point; they agree on ASCII) and numbers are refused
-- (number formatting differs).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_canonical_json_v1(p_value jsonb) RETURNS text
LANGUAGE plpgsql STABLE STRICT SET search_path = pg_catalog, pg_temp AS $canon$
DECLARE
  out text;
BEGIN
  CASE jsonb_typeof(p_value)
  WHEN 'object' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) k WHERE k !~ '^[ -~]*$') THEN
      RAISE EXCEPTION 'SI_INVALID_SHAPE: object keys must be printable ASCII' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT '{' || coalesce(string_agg(to_json(e.key)::text || ':' || si.si_canonical_json_v1(e.value), ',' ORDER BY e.key COLLATE "C"), '') || '}'
      INTO out FROM jsonb_each(p_value) e;
  WHEN 'array' THEN
    SELECT '[' || coalesce(string_agg(si.si_canonical_json_v1(e.value), ',' ORDER BY e.ord), '') || ']'
      INTO out FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ord);
  WHEN 'string' THEN
    out := to_json(normalize(p_value #>> '{}', NFC))::text;
  WHEN 'boolean' THEN
    out := p_value::text;
  WHEN 'null' THEN
    out := 'null';
  ELSE
    RAISE EXCEPTION 'SI_INVALID_SHAPE: numbers are not accepted in canonical v1 input' USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  RETURN out;
END $canon$;

CREATE FUNCTION si.si_fixture_sha256_v1(p_rows jsonb) RETURNS text
LANGUAGE sql STABLE STRICT SET search_path = pg_catalog, pg_temp
AS $$ SELECT encode(sha256(convert_to(si.si_canonical_json_v1(p_rows), 'UTF8')), 'hex') $$;

-- requestSha256 v1: keys adapterId < evidenceKind < fixtureSha256 < networks; networks sorted.
CREATE FUNCTION si.si_request_sha256_v1(p_adapter_id text, p_evidence_kind text, p_networks text[], p_fixture_sha256 text)
RETURNS text
LANGUAGE sql STABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(
    '{"adapterId":' || to_json(normalize(p_adapter_id, NFC))::text ||
    ',"evidenceKind":' || to_json(normalize(p_evidence_kind, NFC))::text ||
    ',"fixtureSha256":' || to_json(p_fixture_sha256)::text ||
    ',"networks":[' || (SELECT coalesce(string_agg(to_json(n)::text, ',' ORDER BY n COLLATE "C"), '') FROM unnest(p_networks) n) || ']}',
    'UTF8')), 'hex')
$$;

------------------------------------------------------------------------------------------
-- run_request_scope: one immutable scope per scoped RUNNING attempt.
------------------------------------------------------------------------------------------
CREATE TABLE si.run_request_scope (
  run_id          uuid PRIMARY KEY,
  source_id       text NOT NULL,
  evidence_kind   text NOT NULL CHECK (evidence_kind ~ '^[A-Z_]{1,40}$'),
  networks        text[] NOT NULL CHECK (cardinality(networks) > 0 AND array_ndims(networks) = 1
                    AND array_position(networks, NULL) IS NULL
                    AND networks <@ ARRAY['META','TIKTOK','GOOGLE','PINTEREST','OTHER']::text[]),
  fixture_sha256  text NOT NULL CHECK (fixture_sha256 ~ '^[0-9a-f]{64}$'),
  hash_version    smallint NOT NULL CHECK (hash_version = 1),
  bound_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- the scope names exactly its run's source
  CONSTRAINT run_scope_run FOREIGN KEY (run_id, source_id) REFERENCES si.collection_runs (run_id, source_id)
);

-- Insert guard (every inserter, owner included): only the scoped T1 wrapper's in-flight binding
-- for the run it has just created is accepted; the run must be RUNNING; the network array must
-- be sorted and duplicate-free. The binding marker is transaction-local and set only by the
-- wrapper. It is defence in depth against a direct owner INSERT, not a boundary against the
-- owner: application roles have no privilege on this table at all.
CREATE FUNCTION si.trg_run_scope_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $scope_insert$
BEGIN
  IF current_setting('si.scope_binding', true) IS DISTINCT FROM NEW.run_id::text THEN
    RAISE EXCEPTION 'SI_SCOPE_BIND_FORBIDDEN: a request scope is recorded only by si_begin_run_scoped for the attempt it creates'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = NEW.run_id AND r.status = 'RUNNING') THEN
    RAISE EXCEPTION 'SI_SCOPE_BIND_FORBIDDEN: run % is not a RUNNING attempt', NEW.run_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.networks IS DISTINCT FROM (SELECT array_agg(DISTINCT n COLLATE "C" ORDER BY n COLLATE "C") FROM unnest(NEW.networks) n) THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: scope networks must be sorted and unique' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  NEW.bound_at := clock_timestamp();
  RETURN NEW;
END $scope_insert$;

CREATE TRIGGER trg_run_scope_insert BEFORE INSERT ON si.run_request_scope
FOR EACH ROW EXECUTE FUNCTION si.trg_run_scope_insert();

-- Immutable for every role, including si_owner.
CREATE FUNCTION si.trg_run_scope_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $scope_guard$
BEGIN
  RAISE EXCEPTION 'SI_SCOPE_IMMUTABLE: request scopes cannot be changed or removed' USING ERRCODE = '23514';
END $scope_guard$;

CREATE TRIGGER trg_run_scope_append_only BEFORE UPDATE OR DELETE ON si.run_request_scope
FOR EACH ROW EXECUTE FUNCTION si.trg_run_scope_append_only();

CREATE TRIGGER trg_run_scope_no_truncate BEFORE TRUNCATE ON si.run_request_scope
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_run_scope_append_only();

------------------------------------------------------------------------------------------
-- Scoped T1 (FD7 option C). One statement: the T1 attempt and its scope commit or roll back
-- together, also under autocommit. Order:
--   1. argument validation and the v1 hash check — no lock, no write; a refusal consumes no attempt;
--   2. the unchanged si.si_begin_run with the same p_networks (its locks, decision table, Q3,
--      REJECTED codes and retry semantics are all unchanged);
--   3. only for a RUNNING outcome (always a row si_begin_run has just inserted: a live attempt
--      raises SI_RUN_IN_PROGRESS, a COMPLETED one returns ALREADY_COMPLETED): record the scope.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_begin_run_scoped(
  p_source_id      text,
  p_request_key    text,
  p_request_sha256 text,
  p_evidence_kind  text,
  p_networks       text[],
  p_fixture_sha256 text
)
RETURNS TABLE (outcome text, run_id uuid, attempt int, status text, outcome_code text, rights_version_id bigint,
               lease_token uuid, lease_expires_at timestamptz, start_control_seq int, retention_state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $begin_scoped$
#variable_conflict use_column
DECLARE
  rec record;
  sorted text[];
BEGIN
  IF p_source_id IS NULL
     OR p_request_sha256 IS NULL OR p_request_sha256 !~ '^[0-9a-f]{64}$'
     OR p_fixture_sha256 IS NULL OR p_fixture_sha256 !~ '^[0-9a-f]{64}$'
     OR p_evidence_kind IS NULL OR p_evidence_kind !~ '^[A-Z_]{1,40}$'
     OR p_networks IS NULL OR cardinality(p_networks) = 0 OR array_ndims(p_networks) <> 1
     OR EXISTS (SELECT 1 FROM unnest(p_networks) n WHERE n IS NULL OR n !~ '^[A-Z]{1,20}$')
     OR (SELECT count(DISTINCT n) FROM unnest(p_networks) n) <> cardinality(p_networks) THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: invalid scoped T1 request' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF si.si_request_sha256_v1(p_source_id, p_evidence_kind, p_networks, p_fixture_sha256) IS DISTINCT FROM p_request_sha256 THEN
    RAISE EXCEPTION 'SI_REQUEST_HASH_MISMATCH: the request hash does not bind this source, evidence kind, network set and fixture'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO rec FROM si.si_begin_run(p_source_id, p_request_key, p_request_sha256, p_evidence_kind, p_networks);

  IF rec.outcome = 'RUNNING' THEN
    SELECT array_agg(n ORDER BY n COLLATE "C") INTO sorted FROM unnest(p_networks) n;
    PERFORM set_config('si.scope_binding', rec.run_id::text, true);
    INSERT INTO si.run_request_scope (run_id, source_id, evidence_kind, networks, fixture_sha256, hash_version)
    VALUES (rec.run_id, p_source_id, p_evidence_kind, sorted, p_fixture_sha256, 1);
    PERFORM set_config('si.scope_binding', '', true);
  END IF;

  RETURN QUERY SELECT rec.outcome, rec.run_id, rec.attempt, rec.status, rec.outcome_code, rec.rights_version_id,
    rec.lease_token, rec.lease_expires_at, rec.start_control_seq, rec.retention_state;
END $begin_scoped$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC; no application-role privilege on run_request_scope; the
-- collector may execute the scoped T1 only (BD1 amendment, docs/b002-m3-design.md).
------------------------------------------------------------------------------------------
REVOKE ALL ON si.run_request_scope FROM PUBLIC;
REVOKE ALL ON FUNCTION
  si.si_canonical_json_v1(jsonb), si.si_fixture_sha256_v1(jsonb),
  si.si_request_sha256_v1(text, text, text[], text),
  si.trg_run_scope_insert(), si.trg_run_scope_append_only(),
  si.si_begin_run_scoped(text, text, text, text, text[], text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_begin_run_scoped(text, text, text, text, text[], text) TO si_collector;
