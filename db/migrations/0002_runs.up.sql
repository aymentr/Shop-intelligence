-- B-002 migration 0002: collection runs, publication receipts, run errors.
-- Spec: B-002 revision 2.1 + Amendments A (A2 EMPTY), B, C (rev 1-3 + H1) + IA-1, and the
-- Milestone 2 plan rev 2 (founder decisions D1, D2', D4, D6).
--
-- STEP 1: tables, CHECK constraints, indexes, IA-1 composite foreign keys, read grants.
-- STEP 2: si_request_lock_key, trg_runs_insert, si_begin_run (T1 preflight) - see below.
-- Not yet present (later steps of the M2 plan):
--   trg_runs_transition (SECURITY INVOKER), heartbeat,
--   trg_runs_no_delete, run_errors integrity checks      -> step 3 (T3, reaper)
--   si_complete_run, trg_runs_publish_check, receipt checks -> step 4 (T2)
-- Until those exist NO application role may write to these tables: write grants are
-- added in the same step as the trigger that enforces them.
-- Runs as si_owner with search_path = pg_catalog, pg_temp (runner), so everything is qualified.
-- References only 0001 objects (dependency rule).

------------------------------------------------------------------------------------------
-- collection_runs
------------------------------------------------------------------------------------------
CREATE TABLE si.collection_runs (
  run_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           text NOT NULL REFERENCES si.sources (source_id),
  request_key         text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_sha256      text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  attempt             int  NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  status              text NOT NULL CHECK (status IN ('REJECTED','RUNNING','COMPLETED','FAILED')),
  outcome_code        text CHECK (outcome_code IN (
                        'NO_RIGHTS','RIGHTS_EXPIRED','RIGHTS_EXPIRING','EVALUATION_NOT_ALLOWED','RETAIN_NOT_ALLOWED',
                        'SOURCE_RETIRED','EVIDENCE_KIND_MISMATCH','NETWORK_SCOPE_MISMATCH','SOURCE_ERROR',
                        'VALIDATION_FAILED','DUPLICATE_CONFLICT','RIGHTS_CHANGED','LEASE_EXPIRED','LOCK_TIMEOUT',
                        'PERSISTENCE_ERROR','INTERNAL',
                        'SOURCE_SUSPENDED','RIGHTS_TERMINATED')),                -- Q2 (founder-approved)
  rights_version_id   bigint,                                               -- NULL only for REJECTED / NO_RIGHTS
  conflict_policy     text NOT NULL CHECK (conflict_policy IN ('FAIL_RUN','KEEP_FIRST')),   -- snapshot at T1
  lease_token         uuid,
  lease_expires_at    timestamptz,
  started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at         timestamptz,
  rights_checked_at   timestamptz,
  -- historical counts: what happened in this attempt (frozen once terminal, step 3)
  received_count      int NOT NULL DEFAULT 0 CHECK (received_count   >= 0),
  published_count     int NOT NULL DEFAULT 0 CHECK (published_count  >= 0),
  duplicate_count     int NOT NULL DEFAULT 0 CHECK (duplicate_count  >= 0),
  conflict_count      int NOT NULL DEFAULT 0 CHECK (conflict_count   >= 0),
  suppressed_count    int NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
  error_count         int NOT NULL DEFAULT 0 CHECK (error_count      >= 0),
  -- retention: what is still held (A2 adds EMPTY)
  retention_state     text NOT NULL DEFAULT 'NONE'
                        CHECK (retention_state IN ('NONE','EMPTY','RETAINED','PARTIALLY_PURGED','PURGED')),
  retain_until        timestamptz,
  first_purged_at     timestamptz,
  purged_at           timestamptz,
  -- Amendment C rev2 C-S2': clock-free control-sequence capture (computed by triggers, steps 2/4)
  start_control_seq   int NOT NULL CHECK (start_control_seq >= 0),
  publish_control_seq int CHECK (publish_control_seq >= 0),

  UNIQUE (source_id, request_key, attempt),
  UNIQUE (run_id, source_id),                                              -- target for run_errors-style FKs
  UNIQUE (run_id, source_id, rights_version_id),                           -- target for the receipt FK
  -- IA-1: a run's rights version belongs to the run's source (MATCH SIMPLE: NULL version allowed)
  CONSTRAINT runs_ia1_rights_version_source
    FOREIGN KEY (rights_version_id, source_id) REFERENCES si.rights_versions (rights_version_id, source_id),

  -- 2.1 per-status shape
  CONSTRAINT runs_rejected_shape CHECK (status <> 'REJECTED' OR (finished_at IS NOT NULL AND outcome_code IS NOT NULL
             AND lease_token IS NULL AND received_count = 0)),
  CONSTRAINT runs_running_shape CHECK (status <> 'RUNNING' OR (finished_at IS NULL AND lease_token IS NOT NULL
             AND lease_expires_at IS NOT NULL AND rights_version_id IS NOT NULL AND outcome_code IS NULL)),
  -- (A2: "retain_until IS NOT NULL" removed from the COMPLETED shape; the EMPTY rules below cover it)
  CONSTRAINT runs_completed_shape CHECK (status <> 'COMPLETED' OR (finished_at IS NOT NULL AND rights_version_id IS NOT NULL
             AND rights_checked_at IS NOT NULL AND outcome_code IS NULL AND error_count = 0 AND lease_token IS NULL
             AND received_count = published_count + duplicate_count + suppressed_count)),
  CONSTRAINT runs_failed_shape CHECK (status <> 'FAILED' OR (finished_at IS NOT NULL AND outcome_code IS NOT NULL
             AND published_count = 0)),
  CONSTRAINT runs_retention_iff_completed CHECK ((status = 'COMPLETED') = (retention_state <> 'NONE')),
  CONSTRAINT runs_first_purged CHECK (retention_state NOT IN ('PARTIALLY_PURGED','PURGED') OR first_purged_at IS NOT NULL),
  CONSTRAINT runs_purged_at CHECK ((retention_state = 'PURGED') = (purged_at IS NOT NULL)),
  -- Amendment A2: successful empty collections
  CONSTRAINT runs_empty_iff_none_published CHECK ((retention_state = 'EMPTY') = (status = 'COMPLETED' AND published_count = 0)),
  CONSTRAINT runs_empty_iff_no_deadline CHECK ((retention_state = 'EMPTY') = (status = 'COMPLETED' AND retain_until IS NULL)),
  CONSTRAINT runs_empty_final CHECK (retention_state <> 'EMPTY' OR (first_purged_at IS NULL AND purged_at IS NULL)),
  -- D4 consistency (makes A2 / 2.1 prose enforceable)
  CONSTRAINT runs_duplicates_cannot_empty CHECK (status <> 'COMPLETED' OR received_count = 0 OR duplicate_count < received_count),
  CONSTRAINT runs_fail_run_no_conflicts CHECK (status <> 'COMPLETED' OR conflict_policy = 'KEEP_FIRST' OR conflict_count = 0),
  CONSTRAINT runs_errors_only_failed CHECK (status = 'FAILED' OR error_count = 0),
  -- Q2 / D6: outcome codes per status (documented meanings, docs/b002-m2-plan.md section 3.3)
  CONSTRAINT runs_rejected_codes CHECK (status <> 'REJECTED' OR outcome_code IN (
             'NO_RIGHTS','RIGHTS_EXPIRED','RIGHTS_EXPIRING','EVALUATION_NOT_ALLOWED','RETAIN_NOT_ALLOWED',
             'SOURCE_RETIRED','EVIDENCE_KIND_MISMATCH','NETWORK_SCOPE_MISMATCH','RIGHTS_TERMINATED')),
  CONSTRAINT runs_failed_codes CHECK (status <> 'FAILED' OR outcome_code IN (
             'SOURCE_ERROR','VALIDATION_FAILED','DUPLICATE_CONFLICT','LEASE_EXPIRED','RIGHTS_TERMINATED',
             'SOURCE_SUSPENDED','SOURCE_RETIRED','RIGHTS_CHANGED','RIGHTS_EXPIRING','LOCK_TIMEOUT',
             'PERSISTENCE_ERROR','INTERNAL')),
  -- Amendment C: control sequences
  CONSTRAINT runs_publish_seq_iff_completed CHECK ((status = 'COMPLETED') = (publish_control_seq IS NOT NULL)),
  CONSTRAINT runs_publish_seq_after_start CHECK (publish_control_seq IS NULL OR publish_control_seq >= start_control_seq),
  -- IA-1 nullability: only a NO_RIGHTS rejection has no rights version
  CONSTRAINT runs_version_required CHECK (rights_version_id IS NOT NULL OR (status = 'REJECTED' AND outcome_code = 'NO_RIGHTS'))
);
CREATE UNIQUE INDEX runs_one_completed ON si.collection_runs (source_id, request_key) WHERE status = 'COMPLETED';
CREATE UNIQUE INDEX runs_one_running   ON si.collection_runs (source_id, request_key) WHERE status = 'RUNNING';
CREATE INDEX runs_lease     ON si.collection_runs (lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX runs_retention ON si.collection_runs (retain_until) WHERE retention_state IN ('RETAINED','PARTIALLY_PURGED');
CREATE INDEX runs_by_rights_version ON si.collection_runs (rights_version_id, source_id);   -- IA-1 FK lookups

------------------------------------------------------------------------------------------
-- publication_receipts: one per COMPLETED run, with the same source/rights-version integrity
------------------------------------------------------------------------------------------
CREATE TABLE si.publication_receipts (
  run_id             uuid PRIMARY KEY,
  source_id          text NOT NULL,
  rights_version_id  bigint NOT NULL,
  receipt_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  commit_ts          timestamptz,                    -- filled by the 0004 monitor (D3)
  within_validity    boolean,                        -- ditto; NULL until verified
  -- the receipt names exactly its run's source and rights version
  CONSTRAINT receipts_match_run
    FOREIGN KEY (run_id, source_id, rights_version_id) REFERENCES si.collection_runs (run_id, source_id, rights_version_id),
  -- IA-1 equivalent: the version belongs to the source
  CONSTRAINT receipts_ia1_rights_version_source
    FOREIGN KEY (rights_version_id, source_id) REFERENCES si.rights_versions (rights_version_id, source_id),
  CONSTRAINT receipts_validity_needs_commit_ts CHECK (within_validity IS NULL OR commit_ts IS NOT NULL)
);
CREATE INDEX receipts_by_rights_version ON si.publication_receipts (rights_version_id, source_id);

------------------------------------------------------------------------------------------
-- run_errors: codes, row indices and field names only (no free text by construction)
------------------------------------------------------------------------------------------
CREATE TABLE si.run_errors (
  run_id             uuid NOT NULL REFERENCES si.collection_runs (run_id),
  seq                int  NOT NULL CHECK (seq BETWEEN 1 AND 100),
  code               text NOT NULL CHECK (code ~ '^[A-Z][A-Z_]{2,40}$'),
  row_index          int  CHECK (row_index >= 0),
  field              text CHECK (field IN ('network','nativeAdId','advertiserName','countries','seenAt',
                       'sourceUrl','title','destinationUrl','creativeUrl',
                       'sourceReportedFirstSeen','sourceReportedLastSeen')),
  correlation_id     uuid NOT NULL,
  PRIMARY KEY (run_id, seq)
);

------------------------------------------------------------------------------------------
-- STEP 2: request-key serialization and T1 preflight (docs/b002-m2-plan.md section 3).
-- Lock order inside T1: rank 1 (advisory request key) -> rank 3 (sources FOR KEY SHARE)
-- -> rank 4 (expired attempt, new attempt). Every dependent read is a later statement, so
-- under READ COMMITTED it sees everything committed by earlier holders of those locks.
------------------------------------------------------------------------------------------

-- Advisory keys use the two-int form (namespace, key): a different keyspace from the
-- runner's single-bigint migration lock. The key is the first 32 bits of SHA-256 over
-- "source_id/request_key" ('/' occurs in neither by their CHECKs), so it is stable across
-- PostgreSQL versions and platforms. A collision only adds harmless serialization.
CREATE FUNCTION si.si_request_lock_namespace() RETURNS int
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT 21321 $$;                                         -- 0x5349, "SI"

CREATE FUNCTION si.si_request_lock_key(p_source_id text, p_request_key text) RETURNS int
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT ('x' || substr(encode(sha256(convert_to(p_source_id || '/' || p_request_key, 'UTF8')), 'hex'), 1, 8))::bit(32)::int
$$;

-- pg_advisory_xact_lock is STRICT: a NULL argument would silently take no lock. Refuse it.
CREATE FUNCTION si.si_lock_request_key(p_source_id text, p_request_key text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_source_id IS NULL OR p_request_key IS NULL THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: source_id and request_key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(si.si_request_lock_namespace(), si.si_request_lock_key(p_source_id, p_request_key));
END $$;

CREATE FUNCTION si.si_run_lease() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT interval '5 minutes' $$;

-- T1 rights decision (2.1 failure-state table + Amendment C + Q2), in this order:
-- NO_RIGHTS, SOURCE_RETIRED, EVIDENCE_KIND_MISMATCH, NETWORK_SCOPE_MISMATCH, RIGHTS_TERMINATED,
-- EVALUATION_NOT_ALLOWED, RETAIN_NOT_ALLOWED, RIGHTS_EXPIRED, RIGHTS_EXPIRING.
-- outcome_code NULL means RUNNING is allowed. The current version is the newest one already in
-- effect at p_at (a scheduled version is not current). The window must outlast the publish
-- margin plus the full lease (2.1 V2 / A11). p_evidence_kind and p_networks may be NULL to
-- skip the request-scope checks (the insert trigger has no request arguments).
-- Suspension is NOT decided here: T1 throws for it before deciding (Q3).
CREATE FUNCTION si.si_t1_rights_decision(p_source_id text, p_at timestamptz, p_evidence_kind text, p_networks text[],
  OUT rights_version_id bigint, OUT outcome_code text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  s record;
  v record;
BEGIN
  SELECT src.evidence_kind, src.supported_networks, src.retired_at INTO s FROM si.sources src WHERE src.source_id = p_source_id;
  SELECT rv.rights_version_id AS id, rv.version, rv.evaluation, rv.retain, rv.expires_at INTO v
    FROM si.rights_versions rv
    WHERE rv.source_id = p_source_id AND rv.effective_from <= p_at
    ORDER BY rv.version DESC LIMIT 1;
  IF v.id IS NULL THEN
    rights_version_id := NULL; outcome_code := 'NO_RIGHTS'; RETURN;
  END IF;
  rights_version_id := v.id;
  IF s.retired_at IS NOT NULL AND s.retired_at <= p_at + si.si_publish_margin() + si.si_run_lease() THEN
    outcome_code := 'SOURCE_RETIRED';
  ELSIF p_evidence_kind IS NOT NULL AND p_evidence_kind <> s.evidence_kind THEN
    outcome_code := 'EVIDENCE_KIND_MISMATCH';
  ELSIF p_networks IS NOT NULL AND NOT (p_networks <@ s.supported_networks) THEN
    outcome_code := 'NETWORK_SCOPE_MISMATCH';
  ELSIF si.si_retention_terminated(p_source_id, v.version) THEN
    outcome_code := 'RIGHTS_TERMINATED';
  ELSIF v.evaluation <> 'ALLOWED' THEN
    outcome_code := 'EVALUATION_NOT_ALLOWED';
  ELSIF v.retain <> 'ALLOWED' THEN
    outcome_code := 'RETAIN_NOT_ALLOWED';
  ELSIF v.expires_at IS NOT NULL AND v.expires_at <= p_at THEN
    outcome_code := 'RIGHTS_EXPIRED';
  ELSIF NOT (p_at + si.si_publish_margin() + si.si_run_lease() < si.si_window_end(v.id)) THEN
    outcome_code := 'RIGHTS_EXPIRING';
  ELSE
    outcome_code := NULL;
  END IF;
END $$;

-- Applies to every inserter, including the owner. Only REJECTED and RUNNING rows can be
-- inserted; numbering, request hash and the per-key rules are re-checked under the same
-- advisory lock T1 holds (re-entrant); computed columns are never taken from the caller;
-- a RUNNING row is re-validated against the current rights. No row of any kind may be
-- inserted while the source is suspended (Q3).
CREATE FUNCTION si.trg_runs_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_attempt int;
  sha_mismatch boolean;
  has_completed boolean;
  now_ts timestamptz;
  dec record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: collection runs require READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM si.si_lock_request_key(NEW.source_id, NEW.request_key);                              -- rank 1
  PERFORM 1 FROM si.sources s WHERE s.source_id = NEW.source_id FOR KEY SHARE;                 -- rank 3
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_UNKNOWN_SOURCE: %', NEW.source_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.status IS NULL OR NEW.status NOT IN ('REJECTED','RUNNING') THEN
    RAISE EXCEPTION 'SI_INSERT_STATUS: only REJECTED or RUNNING attempts can be inserted, got %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(r.attempt), coalesce(bool_or(r.request_sha256 <> NEW.request_sha256), false), coalesce(bool_or(r.status = 'COMPLETED'), false)
    INTO prev_attempt, sha_mismatch, has_completed
    FROM si.collection_runs r WHERE r.source_id = NEW.source_id AND r.request_key = NEW.request_key;
  IF sha_mismatch THEN
    RAISE EXCEPTION 'SI_IDEMPOTENCY_KEY_REUSED: request key % of % was used with a different request hash', NEW.request_key, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF has_completed THEN
    RAISE EXCEPTION 'SI_ALREADY_COMPLETED: request key % of % already has a COMPLETED attempt', NEW.request_key, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(prev_attempt, 0) >= 20 THEN
    RAISE EXCEPTION 'SI_ATTEMPT_LIMIT: request key % of % already has 20 attempts', NEW.request_key, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempt IS DISTINCT FROM coalesce(prev_attempt, 0) + 1 THEN
    RAISE EXCEPTION 'SI_ATTEMPT_SEQUENCE: next attempt for % / % must be %, got %', NEW.source_id, NEW.request_key,
      coalesce(prev_attempt, 0) + 1, NEW.attempt USING ERRCODE = 'check_violation';
  END IF;
  IF si.si_source_suspended(NEW.source_id) THEN
    RAISE EXCEPTION 'SI_SOURCE_SUSPENDED: source % is suspended; no attempt may be recorded', NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;

  now_ts := clock_timestamp();
  -- Computed columns (never from the caller).
  NEW.started_at := now_ts;
  NEW.start_control_seq := coalesce((SELECT max(c.control_seq) FROM si.source_controls c WHERE c.source_id = NEW.source_id), 0);
  NEW.conflict_policy := (SELECT s.conflict_policy FROM si.sources s WHERE s.source_id = NEW.source_id);   -- snapshot at T1
  NEW.received_count := 0; NEW.published_count := 0; NEW.duplicate_count := 0;
  NEW.conflict_count := 0; NEW.suppressed_count := 0; NEW.error_count := 0;
  NEW.retention_state := 'NONE'; NEW.retain_until := NULL; NEW.first_purged_at := NULL; NEW.purged_at := NULL;
  NEW.rights_checked_at := NULL; NEW.publish_control_seq := NULL;

  IF NEW.status = 'RUNNING' THEN
    dec := si.si_t1_rights_decision(NEW.source_id, now_ts, NULL, NULL);
    IF dec.outcome_code IS NOT NULL THEN
      RAISE EXCEPTION 'SI_RUN_NOT_ALLOWED: a RUNNING attempt for % is not allowed now (%)', NEW.source_id, dec.outcome_code
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.rights_version_id IS DISTINCT FROM dec.rights_version_id THEN
      RAISE EXCEPTION 'SI_RUN_NOT_ALLOWED: a RUNNING attempt for % must use the current rights version %, got %',
        NEW.source_id, dec.rights_version_id, NEW.rights_version_id USING ERRCODE = 'check_violation';
    END IF;
    NEW.outcome_code := NULL;
    NEW.finished_at := NULL;
    NEW.lease_token := gen_random_uuid();
    NEW.lease_expires_at := now_ts + si.si_run_lease();
  ELSE
    NEW.finished_at := now_ts;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_runs_insert BEFORE INSERT ON si.collection_runs
  FOR EACH ROW EXECUTE FUNCTION si.trg_runs_insert();

-- T1 preflight: the only way an application role starts an attempt. SECURITY DEFINER
-- (Amendment A4 contract). Decision table (2.1 section C), evaluated under the request-key lock:
--   1 different request hash for the key   -> SI_IDEMPOTENCY_KEY_REUSED (thrown, nothing stored)
--   2 a COMPLETED attempt                  -> outcome ALREADY_COMPLETED (nothing stored)
--   3 a RUNNING attempt with a live lease  -> SI_RUN_IN_PROGRESS (thrown)
--   4 a RUNNING attempt with an expired lease -> that attempt becomes FAILED / LEASE_EXPIRED, continue
--   5 20 attempts already                  -> SI_ATTEMPT_LIMIT (thrown)
--   then: suspended source                  -> SI_SOURCE_SUSPENDED (thrown, no row; Q3)
--   6 otherwise a REJECTED or RUNNING attempt n+1 under the current rights.
-- A throw rolls the whole transaction back, including a row-4 expiry (the reaper redoes it).
CREATE FUNCTION si.si_begin_run(
  p_source_id      text,
  p_request_key    text,
  p_request_sha256 text,
  p_evidence_kind  text,
  p_networks       text[]
)
RETURNS TABLE (outcome text, run_id uuid, attempt int, status text, outcome_code text, rights_version_id bigint,
               lease_token uuid, lease_expires_at timestamptz, start_control_seq int, retention_state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  done si.collection_runs%ROWTYPE;
  r si.collection_runs%ROWTYPE;
  n int;
  dec record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: collection runs require READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_request_sha256 IS NULL OR p_request_sha256 !~ '^[0-9a-f]{64}$'
     OR p_evidence_kind IS NULL OR p_networks IS NULL OR cardinality(p_networks) = 0 OR array_ndims(p_networks) <> 1
     OR array_position(p_networks, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: invalid T1 request' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM si.si_lock_request_key(p_source_id, p_request_key);                                    -- rank 1
  PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR KEY SHARE;                     -- rank 3
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_UNKNOWN_SOURCE: %', p_source_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- 1
  IF EXISTS (SELECT 1 FROM si.collection_runs x WHERE x.source_id = p_source_id AND x.request_key = p_request_key
                AND x.request_sha256 <> p_request_sha256) THEN
    RAISE EXCEPTION 'SI_IDEMPOTENCY_KEY_REUSED: request key % of % was used with a different request hash', p_request_key, p_source_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 2
  SELECT * INTO done FROM si.collection_runs x
    WHERE x.source_id = p_source_id AND x.request_key = p_request_key AND x.status = 'COMPLETED';
  IF FOUND THEN
    RETURN QUERY SELECT 'ALREADY_COMPLETED'::text, done.run_id, done.attempt, done.status, done.outcome_code,
      done.rights_version_id, NULL::uuid, NULL::timestamptz, done.start_control_seq, done.retention_state;
    RETURN;
  END IF;
  -- 3
  IF EXISTS (SELECT 1 FROM si.collection_runs x WHERE x.source_id = p_source_id AND x.request_key = p_request_key
                AND x.status = 'RUNNING' AND x.lease_expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'SI_RUN_IN_PROGRESS: request key % of % has a live RUNNING attempt', p_request_key, p_source_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 4 (rank 4: after the source lock)
  UPDATE si.collection_runs x
     SET status = 'FAILED', outcome_code = 'LEASE_EXPIRED', finished_at = clock_timestamp(), lease_token = NULL
   WHERE x.source_id = p_source_id AND x.request_key = p_request_key
     AND x.status = 'RUNNING' AND x.lease_expires_at <= clock_timestamp();
  -- 5
  SELECT count(*) INTO n FROM si.collection_runs x WHERE x.source_id = p_source_id AND x.request_key = p_request_key;
  IF n >= 20 THEN
    RAISE EXCEPTION 'SI_ATTEMPT_LIMIT: request key % of % already has 20 attempts', p_request_key, p_source_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Q3
  IF si.si_source_suspended(p_source_id) THEN
    RAISE EXCEPTION 'SI_SOURCE_SUSPENDED: source % is suspended; no attempt is recorded', p_source_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- 6
  dec := si.si_t1_rights_decision(p_source_id, clock_timestamp(), p_evidence_kind, p_networks);
  INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code,
                                  rights_version_id, conflict_policy, start_control_seq)
  VALUES (p_source_id, p_request_key, p_request_sha256, n + 1,
          CASE WHEN dec.outcome_code IS NULL THEN 'RUNNING' ELSE 'REJECTED' END, dec.outcome_code,
          dec.rights_version_id, 'FAIL_RUN', 0)              -- conflict_policy and start_control_seq are computed by the trigger
  RETURNING * INTO r;
  RETURN QUERY SELECT r.status, r.run_id, r.attempt, r.status, r.outcome_code, r.rights_version_id,
    r.lease_token, r.lease_expires_at, r.start_control_seq, r.retention_state;
END $$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing is granted to PUBLIC. Step 1: read only. Step 2: the collector may
-- execute si_begin_run; it has no INSERT or UPDATE privilege on the run tables.
------------------------------------------------------------------------------------------
REVOKE ALL ON si.collection_runs, si.publication_receipts, si.run_errors FROM PUBLIC;
GRANT SELECT ON si.collection_runs TO si_collector, si_rights_admin, si_retention;
GRANT SELECT ON si.publication_receipts TO si_collector, si_retention;
GRANT SELECT ON si.run_errors TO si_retention;

REVOKE ALL ON FUNCTION
  si.si_request_lock_namespace(), si.si_request_lock_key(text, text), si.si_lock_request_key(text, text),
  si.si_run_lease(), si.si_t1_rights_decision(text, timestamptz, text, text[]), si.trg_runs_insert(),
  si.si_begin_run(text, text, text, text, text[])
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_begin_run(text, text, text, text, text[]) TO si_collector;
