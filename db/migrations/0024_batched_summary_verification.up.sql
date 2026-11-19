-- B-002 migration 0024: M4-P3.3 Phase 2 — bounded, resumable, auditable verification of the 0020 advertiser summaries.
-- Contract: docs/b002-m4-intelligence.md §18. Synthetic only. Adds tables, triggers and functions; changes no existing
-- object (si_verify_summaries, the 0020 guards, coverage, the 0023 reader and every grant are unchanged). Down restores
-- the exact 0023 catalog.
--
-- A SWEEP verifies one source in BATCHES. Each batch is one REPEATABLE READ transaction (one consistent snapshot; no
-- snapshot is claimed across batches), bounded by runs, observations and identities, and takes NO source lock: only its
-- own sweep row (FOR NO KEY UPDATE NOWAIT, compatible with the FK key-share of the failure record). Its scope is fixed at start: the normalizer fingerprint, the run boundary (the
-- greatest (finished_at, run_id) of the source's COMPLETED RETAINED/EMPTY runs) and the identity boundary. Phases:
--   RUNS           runs in scope, in (finished_at, run_id) order after the cursor;
--   RUN_GAPS       in-scope runs not yet recorded by this sweep (late commits below the cursor, a corrupted cursor);
--   IDENTITIES     the source's dictionary in identity_id order after the cursor;
--   IDENTITY_GAPS  in-scope identities not yet recorded;
--   DONE           final state: COMPLETED_DRIFT if any finding, else INCOMPLETE if any run could not be verified, else
--                  COMPLETED_CLEAN.
-- Per run the findings are those of si_verify_summaries (0020): MISSING, CONTENT_MISMATCH, STATUS_MISMATCH; per identity
-- ORPHAN_IDENTITY, IDENTITY_MISMATCH. Each finding records DRIFT_DETECTED in the batch's transaction (the 0021/0023 guard
-- then refuses summary-backed reads). A sweep never records DRIFT_CLEARED: clearance is si_summary_clear_drift (owner).

------------------------------------------------------------------------------------------
-- State
------------------------------------------------------------------------------------------
CREATE TABLE si.summary_sweeps (
  sweep_id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id                 text NOT NULL REFERENCES si.sources (source_id),
  normalizer                text NOT NULL CHECK (normalizer ~ '^v[0-9]+\|'),
  boundary_finished_at      timestamptz,
  boundary_run_id           uuid,
  boundary_identity_id      bigint,
  start_event_id            bigint NOT NULL CHECK (start_event_id >= 0),
  scope_runs                int NOT NULL CHECK (scope_runs >= 0),
  scope_identities          int NOT NULL CHECK (scope_identities >= 0),
  state                     text NOT NULL DEFAULT 'IN_PROGRESS'
                            CHECK (state IN ('IN_PROGRESS', 'COMPLETED_CLEAN', 'COMPLETED_DRIFT', 'INCOMPLETE', 'STALE')),
  phase                     text NOT NULL DEFAULT 'RUNS' CHECK (phase IN ('RUNS', 'RUN_GAPS', 'IDENTITIES', 'IDENTITY_GAPS', 'DONE')),
  cursor_finished_at        timestamptz,
  cursor_run_id             uuid,
  cursor_identity_id        bigint,
  batches                   int NOT NULL DEFAULT 0 CHECK (batches >= 0),
  runs_verified             int NOT NULL DEFAULT 0 CHECK (runs_verified >= 0),
  observations_verified     bigint NOT NULL DEFAULT 0 CHECK (observations_verified >= 0),
  identities_verified       int NOT NULL DEFAULT 0 CHECK (identities_verified >= 0),
  drift_findings            int NOT NULL DEFAULT 0 CHECK (drift_findings >= 0),
  unverifiable_runs         int NOT NULL DEFAULT 0 CHECK (unverifiable_runs >= 0),
  stale_reason              text CHECK (stale_reason IN ('FINGERPRINT_CHANGED', 'ABANDONED')),
  started_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_by                text NOT NULL DEFAULT session_user,
  last_batch_at             timestamptz,
  completed_at              timestamptz,
  CHECK ((boundary_finished_at IS NULL) = (boundary_run_id IS NULL)),
  CHECK ((cursor_finished_at IS NULL) = (cursor_run_id IS NULL)),
  CHECK ((state = 'IN_PROGRESS') = (completed_at IS NULL)),
  CHECK ((state = 'STALE') = (stale_reason IS NOT NULL)),
  CHECK (state IN ('IN_PROGRESS', 'STALE') OR phase = 'DONE'),
  CHECK (phase <> 'DONE' OR state <> 'IN_PROGRESS'),
  CHECK (state <> 'COMPLETED_CLEAN' OR (drift_findings = 0 AND unverifiable_runs = 0)),
  CHECK (state <> 'COMPLETED_DRIFT' OR drift_findings > 0),
  CHECK (state <> 'INCOMPLETE' OR (drift_findings = 0 AND unverifiable_runs > 0))
);
CREATE UNIQUE INDEX summary_sweeps_one_active ON si.summary_sweeps (source_id) WHERE state = 'IN_PROGRESS';
CREATE INDEX summary_sweeps_by_source ON si.summary_sweeps (source_id, sweep_id);

-- One row per committed batch (seq 1, 2, ... without gaps); the replay record of a lost response.
CREATE TABLE si.summary_sweep_batches (
  sweep_id            bigint NOT NULL REFERENCES si.summary_sweeps (sweep_id),
  seq                 int NOT NULL CHECK (seq >= 1),
  phase               text NOT NULL CHECK (phase IN ('RUNS', 'RUN_GAPS', 'IDENTITIES', 'IDENTITY_GAPS')),
  phase_after         text NOT NULL CHECK (phase_after IN ('RUNS', 'RUN_GAPS', 'IDENTITIES', 'IDENTITY_GAPS', 'DONE')),
  outcome             text NOT NULL CHECK (outcome IN ('OK', 'DRIFT', 'UNVERIFIABLE', 'STALE')),
  state_after         text NOT NULL,
  runs                int NOT NULL CHECK (runs >= 0),
  observations        bigint NOT NULL CHECK (observations >= 0),
  identities          int NOT NULL CHECK (identities >= 0),
  findings            int NOT NULL CHECK (findings >= 0),
  unverifiable        int NOT NULL CHECK (unverifiable >= 0),
  max_runs            int NOT NULL,
  max_observations    int NOT NULL,
  max_identities      int NOT NULL,
  cursor_finished_at  timestamptz,
  cursor_run_id       uuid,
  cursor_identity_id  bigint,
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by         text NOT NULL DEFAULT session_user,
  PRIMARY KEY (sweep_id, seq)
);

-- Every run a sweep looked at, with its outcome (also the gap phase's "already recorded" set).
CREATE TABLE si.summary_sweep_runs (
  sweep_id      bigint NOT NULL REFERENCES si.summary_sweeps (sweep_id),
  run_id        uuid NOT NULL,
  seq           int NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('VERIFIED', 'DRIFT', 'UNVERIFIABLE_OVERSIZED', 'UNVERIFIABLE_STALE_STATUS')),
  observations  int NOT NULL CHECK (observations >= 0),
  PRIMARY KEY (sweep_id, run_id)
);

CREATE TABLE si.summary_sweep_identities (
  sweep_id     bigint NOT NULL REFERENCES si.summary_sweeps (sweep_id),
  identity_id  bigint NOT NULL,
  seq          int NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('VERIFIED', 'DRIFT')),
  PRIMARY KEY (sweep_id, identity_id)
);

-- Attempts that did not commit a batch (recorded in their own transaction by the caller): explicit, never silent.
CREATE TABLE si.summary_sweep_failures (
  failure_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sweep_id     bigint NOT NULL REFERENCES si.summary_sweeps (sweep_id),
  seq          int NOT NULL CHECK (seq >= 1),
  code         text NOT NULL CHECK (code IN ('TIMEOUT', 'BUSY', 'SERIALIZATION', 'ISOLATION', 'SEQUENCE', 'CLOSED', 'CONNECTION', 'ERROR')),
  sqlstate     text CHECK (sqlstate ~ '^[0-9A-Z]{5}$'),
  recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by  text NOT NULL DEFAULT session_user
);

-- The authorized recovery: which clean sweep justified which DRIFT_CLEARED.
CREATE TABLE si.summary_drift_clearances (
  event_id    bigint PRIMARY KEY,                                  -- the DRIFT_CLEARED event (no FK: 0020's TRUNCATE refusal stays its own)
  source_id   text NOT NULL REFERENCES si.sources (source_id),
  sweep_id    bigint NOT NULL REFERENCES si.summary_sweeps (sweep_id),
  cleared_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleared_by  text NOT NULL DEFAULT session_user
);

-- Cursor order of the two phases (each batch reads only the next LIMIT keys; without these a sweep would be O(n^2)).
-- Both tables are small relative to si.observations; the build takes the usual non-concurrent lock for its duration
-- (docs §18: populated databases follow the §17.2 concurrent-build reasoning if that duration matters).
CREATE INDEX collection_runs_sweep_order ON si.collection_runs (source_id, finished_at, run_id)
 WHERE status = 'COMPLETED' AND retention_state IN ('RETAINED', 'EMPTY');
CREATE INDEX advertiser_identities_sweep_order ON si.advertiser_identities (source_id, identity_id);

------------------------------------------------------------------------------------------
-- Append-only records and the sweep state machine
------------------------------------------------------------------------------------------
CREATE FUNCTION si.trg_sweep_records_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $sweep_append_only$
BEGIN
  RAISE EXCEPTION 'SI_VERIFICATION_APPEND_ONLY: % is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $sweep_append_only$;
CREATE TRIGGER trg_sweep_batches_append_only BEFORE UPDATE OR DELETE ON si.summary_sweep_batches
FOR EACH ROW EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_batches_no_truncate BEFORE TRUNCATE ON si.summary_sweep_batches
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_runs_append_only BEFORE UPDATE OR DELETE ON si.summary_sweep_runs
FOR EACH ROW EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_runs_no_truncate BEFORE TRUNCATE ON si.summary_sweep_runs
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_identities_append_only BEFORE UPDATE OR DELETE ON si.summary_sweep_identities
FOR EACH ROW EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_identities_no_truncate BEFORE TRUNCATE ON si.summary_sweep_identities
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_failures_append_only BEFORE UPDATE OR DELETE ON si.summary_sweep_failures
FOR EACH ROW EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweep_failures_no_truncate BEFORE TRUNCATE ON si.summary_sweep_failures
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_drift_clearances_append_only BEFORE UPDATE OR DELETE ON si.summary_drift_clearances
FOR EACH ROW EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_drift_clearances_no_truncate BEFORE TRUNCATE ON si.summary_drift_clearances
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_sweep_records_append_only();
CREATE TRIGGER trg_sweeps_no_truncate BEFORE TRUNCATE ON si.summary_sweeps
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_sweep_records_append_only();

-- A sweep row changes only forward: its scope never changes, a terminal state is final, counters only grow, and each
-- batch moves it by exactly one committed batch record whose cursor and phase it must carry. Expiry (STALE) is the only
-- change without a batch.
CREATE FUNCTION si.trg_summary_sweep_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $sweep_transition$
DECLARE
  b record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: sweeps are never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: sweep % is % (final)', OLD.sweep_id, OLD.state USING ERRCODE = '23514';
  END IF;
  IF (NEW.sweep_id, NEW.source_id, NEW.normalizer, NEW.boundary_finished_at, NEW.boundary_run_id, NEW.boundary_identity_id,
      NEW.start_event_id, NEW.scope_runs, NEW.scope_identities, NEW.started_at, NEW.started_by)
     IS DISTINCT FROM
     (OLD.sweep_id, OLD.source_id, OLD.normalizer, OLD.boundary_finished_at, OLD.boundary_run_id, OLD.boundary_identity_id,
      OLD.start_event_id, OLD.scope_runs, OLD.scope_identities, OLD.started_at, OLD.started_by) THEN
    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: the scope of sweep % is immutable', OLD.sweep_id USING ERRCODE = '23514';
  END IF;
  IF NEW.runs_verified < OLD.runs_verified OR NEW.observations_verified < OLD.observations_verified
     OR NEW.identities_verified < OLD.identities_verified OR NEW.drift_findings < OLD.drift_findings
     OR NEW.unverifiable_runs < OLD.unverifiable_runs THEN
    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: counters of sweep % only grow', OLD.sweep_id USING ERRCODE = '23514';
  END IF;
  IF NEW.batches = OLD.batches THEN
    IF NEW.state <> 'STALE' OR (NEW.phase, NEW.cursor_finished_at, NEW.cursor_run_id, NEW.cursor_identity_id,
                                NEW.runs_verified, NEW.observations_verified, NEW.identities_verified, NEW.drift_findings,
                                NEW.unverifiable_runs)
                               IS DISTINCT FROM (OLD.phase, OLD.cursor_finished_at, OLD.cursor_run_id, OLD.cursor_identity_id,
                                OLD.runs_verified, OLD.observations_verified, OLD.identities_verified, OLD.drift_findings,
                                OLD.unverifiable_runs) THEN
      RAISE EXCEPTION 'SI_SWEEP_TRANSITION: sweep % changed without a batch', OLD.sweep_id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.batches <> OLD.batches + 1 THEN
    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: sweep % advanced by more than one batch', OLD.sweep_id USING ERRCODE = '23514';
  END IF;
  SELECT * INTO b FROM si.summary_sweep_batches x WHERE x.sweep_id = NEW.sweep_id AND x.seq = NEW.batches;
  IF NOT FOUND OR b.phase IS DISTINCT FROM OLD.phase OR b.phase_after IS DISTINCT FROM NEW.phase OR b.state_after IS DISTINCT FROM NEW.state
     OR (b.cursor_finished_at, b.cursor_run_id, b.cursor_identity_id)
        IS DISTINCT FROM (NEW.cursor_finished_at, NEW.cursor_run_id, NEW.cursor_identity_id)
     OR NEW.runs_verified + NEW.unverifiable_runs - OLD.runs_verified - OLD.unverifiable_runs <> b.runs
     OR NEW.observations_verified - OLD.observations_verified <> b.observations
     OR NEW.identities_verified - OLD.identities_verified <> b.identities
     OR NEW.drift_findings - OLD.drift_findings <> b.findings
     OR NEW.unverifiable_runs - OLD.unverifiable_runs <> b.unverifiable THEN
    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: sweep % does not match its batch %', OLD.sweep_id, NEW.batches USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $sweep_transition$;
CREATE TRIGGER trg_summary_sweep_transition BEFORE UPDATE OR DELETE ON si.summary_sweeps
FOR EACH ROW EXECUTE FUNCTION si.trg_summary_sweep_transition();

------------------------------------------------------------------------------------------
-- Verifying one run inside a batch (the 0020 per-run rules; the content is derived ONCE). Returns the findings.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_sweep_verify_run(p_run_id uuid, p_fp text, p_observations int)
RETURNS text[]
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $sweep_verify_run$
DECLARE
  st record;
  content si.summary_row[];
  res text[] := '{}';
BEGIN
  SELECT s.normalizer, s.observation_count, s.summary_rows, s.content_digest INTO st FROM si.run_summary_status s WHERE s.run_id = p_run_id;
  IF NOT FOUND THEN
    RETURN ARRAY['MISSING'];
  END IF;
  IF st.normalizer IS DISTINCT FROM p_fp THEN
    RETURN NULL;                                                     -- stale status: not verifiable under this fingerprint
  END IF;
  SELECT coalesce(array_agg(c), '{}') INTO content FROM si.si_summary_content(p_run_id) c;
  IF EXISTS (SELECT * FROM unnest(content) EXCEPT ALL SELECT * FROM si.si_summary_stored(p_run_id))
     OR EXISTS (SELECT * FROM si.si_summary_stored(p_run_id) EXCEPT ALL SELECT * FROM unnest(content)) THEN
    res := res || 'CONTENT_MISMATCH'::text;
  END IF;
  IF st.observation_count <> p_observations
     OR st.summary_rows <> (SELECT count(*) FROM si.run_advertiser_summaries x WHERE x.run_id = p_run_id)
     OR st.content_digest IS DISTINCT FROM (SELECT si.si_summary_digest(array_agg(c.advertiser_key), array_agg(c.network),
                                              array_agg(c.observations), array_agg(c.ad_ids::text), array_agg(c.names::text))
                                            FROM unnest(content) c) THEN
    res := res || 'STATUS_MISMATCH'::text;
  END IF;
  RETURN res;
END $sweep_verify_run$;

------------------------------------------------------------------------------------------
-- Start (or resume) the sweep of a source. Takes no source lock. An IN_PROGRESS sweep under another fingerprint, or idle
-- for longer than p_idle, becomes STALE and a new one starts; otherwise the existing sweep is returned (created = false).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_summary_sweep_start(p_source_id text, p_idle interval DEFAULT interval '6 hours')
RETURNS TABLE (sweep_id bigint, created boolean, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $sweep_start$
DECLARE
  fp text := si.si_normalizer_fingerprint();
  w record;
  bf timestamptz; br uuid; bi bigint; nr int; ni int; ev bigint; id bigint;
BEGIN
  IF p_idle IS NULL OR p_idle < interval '5 minutes' THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: idle interval must be at least 5 minutes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM si.sources s WHERE s.source_id = p_source_id) THEN
    RAISE EXCEPTION 'SI_SWEEP_NO_SOURCE: unknown source' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO w FROM si.summary_sweeps x WHERE x.source_id = p_source_id AND x.state = 'IN_PROGRESS';
  IF FOUND THEN
    IF w.normalizer IS DISTINCT FROM fp OR coalesce(w.last_batch_at, w.started_at) < clock_timestamp() - p_idle THEN
      UPDATE si.summary_sweeps x SET state = 'STALE', completed_at = clock_timestamp(),
             stale_reason = CASE WHEN w.normalizer IS DISTINCT FROM fp THEN 'FINGERPRINT_CHANGED' ELSE 'ABANDONED' END
       WHERE x.sweep_id = w.sweep_id AND x.state = 'IN_PROGRESS';
    ELSE
      RETURN QUERY SELECT w.sweep_id, false, w.state;
      RETURN;
    END IF;
  END IF;
  SELECT r.finished_at, r.run_id INTO bf, br FROM si.collection_runs r
   WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
   ORDER BY r.finished_at DESC, r.run_id DESC LIMIT 1;
  SELECT count(*)::int INTO nr FROM si.collection_runs r
   WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY');
  SELECT max(i.identity_id), count(*)::int INTO bi, ni FROM si.advertiser_identities i WHERE i.source_id = p_source_id;
  SELECT coalesce(max(e.event_id), 0) INTO ev FROM si.summary_events e WHERE e.source_id = p_source_id;
  BEGIN
    INSERT INTO si.summary_sweeps (source_id, normalizer, boundary_finished_at, boundary_run_id, boundary_identity_id,
                                   start_event_id, scope_runs, scope_identities)
    VALUES (p_source_id, fp, bf, br, bi, ev, nr, ni) RETURNING summary_sweeps.sweep_id INTO id;
  EXCEPTION WHEN unique_violation THEN                               -- a concurrent start won: use its sweep
    RETURN QUERY SELECT x.sweep_id, false, x.state FROM si.summary_sweeps x WHERE x.source_id = p_source_id AND x.state = 'IN_PROGRESS';
    RETURN;
  END;
  RETURN QUERY SELECT id, true, 'IN_PROGRESS'::text;
END $sweep_start$;

------------------------------------------------------------------------------------------
-- One bounded batch. The caller's transaction must be REPEATABLE READ (one snapshot for the whole batch) and should set
-- statement_timeout. p_seq must be the next batch (batches + 1); the last committed seq is REPLAYED (its stored result,
-- nothing re-executed). Budgets: runs 1..200, observations 500..20000 (>= the 500-row publication cap, so every
-- publishable run fits), identities 1..5000. A run's size is probed with LIMIT budget+1 and the probe counts as work.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_summary_sweep_batch(p_sweep_id bigint, p_seq int, p_max_runs int DEFAULT 50,
  p_max_observations int DEFAULT 5000, p_max_identities int DEFAULT 1000)
RETURNS TABLE (seq int, state text, phase text, outcome text, runs int, observations bigint, identities int, findings int,
               unverifiable int, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $sweep_batch$
DECLARE
  w record;
  b record;
  x record;
  fp text;
  ph text;
  nxt text;
  st text;
  n int;
  f text[];
  work bigint := 0;
  v_runs int := 0; v_ver int := 0; v_obs bigint := 0; v_ids int := 0; v_find int := 0; v_unv int := 0;
  c_fin timestamptz; c_run uuid; c_id bigint;
  stale boolean := false;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN
    RAISE EXCEPTION 'SI_ISOLATION: a verification batch requires REPEATABLE READ' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_max_runs IS NULL OR p_max_runs < 1 OR p_max_runs > 200 OR p_max_observations IS NULL OR p_max_observations < 500
     OR p_max_observations > 20000 OR p_max_identities IS NULL OR p_max_identities < 1 OR p_max_identities > 5000 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: batch budget out of range' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO w FROM si.summary_sweeps s WHERE s.sweep_id = p_sweep_id FOR NO KEY UPDATE NOWAIT;   -- 55P03: another verifier
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SI_SWEEP_UNKNOWN: no sweep %', p_sweep_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_seq IS NOT NULL AND p_seq >= 1 AND p_seq = w.batches THEN                             -- replay: lost response / duplicate
    SELECT * INTO b FROM si.summary_sweep_batches s WHERE s.sweep_id = p_sweep_id AND s.seq = p_seq;
    RETURN QUERY SELECT b.seq, b.state_after, b.phase_after, b.outcome, b.runs, b.observations, b.identities, b.findings, b.unverifiable, true;
    RETURN;
  END IF;
  IF w.state <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'SI_SWEEP_CLOSED: sweep % is %', p_sweep_id, w.state USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_seq IS NULL OR p_seq <> w.batches + 1 THEN
    RAISE EXCEPTION 'SI_SWEEP_SEQUENCE: next batch of sweep % is %', p_sweep_id, w.batches + 1 USING ERRCODE = 'invalid_parameter_value';
  END IF;
  fp := si.si_normalizer_fingerprint();
  ph := w.phase; nxt := w.phase; st := 'IN_PROGRESS';
  c_fin := w.cursor_finished_at; c_run := w.cursor_run_id; c_id := w.cursor_identity_id;
  IF fp IS DISTINCT FROM w.normalizer THEN
    stale := true;
  ELSIF ph IN ('RUNS', 'RUN_GAPS') THEN
    FOR x IN
      SELECT r.run_id, r.finished_at FROM si.collection_runs r
       WHERE ph = 'RUNS' AND r.source_id = w.source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
         AND w.boundary_run_id IS NOT NULL
         AND (r.finished_at, r.run_id) <= (w.boundary_finished_at, w.boundary_run_id)
         AND (c_run IS NULL OR (r.finished_at, r.run_id) > (c_fin, c_run))
      UNION ALL
      SELECT r.run_id, r.finished_at FROM si.collection_runs r
       WHERE ph = 'RUN_GAPS' AND r.source_id = w.source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
         AND w.boundary_run_id IS NOT NULL
         AND (r.finished_at, r.run_id) <= (w.boundary_finished_at, w.boundary_run_id)
         AND NOT EXISTS (SELECT 1 FROM si.summary_sweep_runs v WHERE v.sweep_id = w.sweep_id AND v.run_id = r.run_id)
      ORDER BY 2, 1
      LIMIT p_max_runs
    LOOP
      SELECT count(*)::int INTO n FROM (SELECT 1 FROM si.observations o WHERE o.run_id = x.run_id LIMIT p_max_observations + 1) q;
      IF n > p_max_observations THEN                                -- cannot be verified within any batch budget
        IF v_runs > 0 THEN EXIT; END IF;
        INSERT INTO si.summary_sweep_runs (sweep_id, run_id, seq, outcome, observations) VALUES (w.sweep_id, x.run_id, p_seq, 'UNVERIFIABLE_OVERSIZED', 0);
        v_runs := v_runs + 1; v_unv := v_unv + 1; work := work + n;
        IF ph = 'RUNS' THEN c_fin := x.finished_at; c_run := x.run_id; END IF;
        EXIT;                                                         -- the probe spent the budget
      END IF;
      IF v_runs > 0 AND work + n > p_max_observations THEN EXIT; END IF;   -- defer: the next batch starts with it
      f := si.si_sweep_verify_run(x.run_id, w.normalizer, n);
      work := work + n; v_runs := v_runs + 1;
      IF f IS NULL THEN
        INSERT INTO si.summary_sweep_runs (sweep_id, run_id, seq, outcome, observations) VALUES (w.sweep_id, x.run_id, p_seq, 'UNVERIFIABLE_STALE_STATUS', n);
        v_unv := v_unv + 1;
      ELSE
        INSERT INTO si.summary_sweep_runs (sweep_id, run_id, seq, outcome, observations)
        VALUES (w.sweep_id, x.run_id, p_seq, CASE WHEN cardinality(f) > 0 THEN 'DRIFT' ELSE 'VERIFIED' END, n);
        v_ver := v_ver + 1; v_obs := v_obs + n;
        IF cardinality(f) > 0 THEN
          INSERT INTO si.summary_events (source_id, run_id, kind, finding) SELECT w.source_id, x.run_id, 'DRIFT_DETECTED', k FROM unnest(f) k;
          v_find := v_find + cardinality(f);
        END IF;
      END IF;
      IF ph = 'RUNS' THEN c_fin := x.finished_at; c_run := x.run_id; END IF;
    END LOOP;
    IF v_runs = 0 THEN nxt := CASE ph WHEN 'RUNS' THEN 'RUN_GAPS' ELSE 'IDENTITIES' END; END IF;
  ELSE                                                               -- IDENTITIES, IDENTITY_GAPS
    FOR x IN
      SELECT i.identity_id, i.advertiser_key, i.normalized_name FROM si.advertiser_identities i
       WHERE ph = 'IDENTITIES' AND i.source_id = w.source_id AND w.boundary_identity_id IS NOT NULL
         AND i.identity_id <= w.boundary_identity_id AND (c_id IS NULL OR i.identity_id > c_id)
      UNION ALL
      SELECT i.identity_id, i.advertiser_key, i.normalized_name FROM si.advertiser_identities i
       WHERE ph = 'IDENTITY_GAPS' AND i.source_id = w.source_id AND w.boundary_identity_id IS NOT NULL
         AND i.identity_id <= w.boundary_identity_id
         AND NOT EXISTS (SELECT 1 FROM si.summary_sweep_identities v WHERE v.sweep_id = w.sweep_id AND v.identity_id = i.identity_id)
      ORDER BY 1
      LIMIT p_max_identities
    LOOP
      f := '{}';
      IF NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries s WHERE s.identity_id = x.identity_id) THEN f := f || 'ORPHAN_IDENTITY'::text; END IF;
      IF x.advertiser_key IS DISTINCT FROM sha256(convert_to(x.normalized_name, 'UTF8')) THEN f := f || 'IDENTITY_MISMATCH'::text; END IF;
      INSERT INTO si.summary_sweep_identities (sweep_id, identity_id, seq, outcome)
      VALUES (w.sweep_id, x.identity_id, p_seq, CASE WHEN cardinality(f) > 0 THEN 'DRIFT' ELSE 'VERIFIED' END);
      IF cardinality(f) > 0 THEN
        INSERT INTO si.summary_events (source_id, run_id, kind, finding) SELECT w.source_id, NULL, 'DRIFT_DETECTED', k FROM unnest(f) k;
        v_find := v_find + cardinality(f);
      END IF;
      v_ids := v_ids + 1;
      IF ph = 'IDENTITIES' THEN c_id := x.identity_id; END IF;
    END LOOP;
    IF v_ids = 0 THEN nxt := CASE ph WHEN 'IDENTITIES' THEN 'IDENTITY_GAPS' ELSE 'DONE' END; END IF;
  END IF;
  IF stale THEN
    st := 'STALE';
  ELSIF nxt = 'DONE' THEN
    st := CASE WHEN w.drift_findings + v_find > 0 THEN 'COMPLETED_DRIFT'
               WHEN w.unverifiable_runs + v_unv > 0 THEN 'INCOMPLETE' ELSE 'COMPLETED_CLEAN' END;
  END IF;
  INSERT INTO si.summary_sweep_batches (sweep_id, seq, phase, phase_after, outcome, state_after, runs, observations, identities,
                                        findings, unverifiable, max_runs, max_observations, max_identities,
                                        cursor_finished_at, cursor_run_id, cursor_identity_id)
  VALUES (w.sweep_id, p_seq, ph, nxt, CASE WHEN stale THEN 'STALE' WHEN v_find > 0 THEN 'DRIFT' WHEN v_unv > 0 THEN 'UNVERIFIABLE' ELSE 'OK' END,
          st, v_runs, v_obs, v_ids, v_find, v_unv, p_max_runs, p_max_observations, p_max_identities, c_fin, c_run, c_id);
  UPDATE si.summary_sweeps s
     SET batches = p_seq, phase = nxt, state = st, cursor_finished_at = c_fin, cursor_run_id = c_run, cursor_identity_id = c_id,
         runs_verified = s.runs_verified + v_ver, observations_verified = s.observations_verified + v_obs,
         identities_verified = s.identities_verified + v_ids, drift_findings = s.drift_findings + v_find,
         unverifiable_runs = s.unverifiable_runs + v_unv, last_batch_at = clock_timestamp(),
         stale_reason = CASE WHEN stale THEN 'FINGERPRINT_CHANGED' END,
         completed_at = CASE WHEN st <> 'IN_PROGRESS' THEN clock_timestamp() END
   WHERE s.sweep_id = w.sweep_id;
  RETURN QUERY SELECT p_seq, st, nxt,
    CASE WHEN stale THEN 'STALE' WHEN v_find > 0 THEN 'DRIFT' WHEN v_unv > 0 THEN 'UNVERIFIABLE' ELSE 'OK' END,
    v_runs, v_obs, v_ids, v_find, v_unv, false;
END $sweep_batch$;

-- A batch attempt that did not commit, recorded by the caller in a new transaction (explicit, content-free).
CREATE FUNCTION si.si_summary_sweep_record_failure(p_sweep_id bigint, p_seq int, p_code text, p_sqlstate text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $sweep_failure$
BEGIN
  INSERT INTO si.summary_sweep_failures (sweep_id, seq, code, sqlstate) VALUES (p_sweep_id, p_seq, p_code, p_sqlstate);
END $sweep_failure$;

-- Sweeps idle longer than p_idle become STALE (ABANDONED); returns how many.
CREATE FUNCTION si.si_summary_sweep_expire(p_idle interval DEFAULT interval '6 hours')
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $sweep_expire$
DECLARE
  k int;
BEGIN
  IF p_idle IS NULL OR p_idle < interval '5 minutes' THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: idle interval must be at least 5 minutes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE si.summary_sweeps s SET state = 'STALE', stale_reason = 'ABANDONED', completed_at = clock_timestamp()
   WHERE s.state = 'IN_PROGRESS' AND coalesce(s.last_batch_at, s.started_at) < clock_timestamp() - p_idle;
  GET DIAGNOSTICS k = ROW_COUNT;
  RETURN k;
END $sweep_expire$;

-- Content-free operational signal per source (NOT_STARTED when the source has no sweep): the latest sweep, its progress,
-- failures, open drift and summary eligibility (R-48).
CREATE FUNCTION si.si_summary_verification_status()
RETURNS TABLE (source_id text, sweep_id bigint, state text, phase text, batches int, scope_runs int, runs_verified int,
               unverifiable_runs int, observations_verified bigint, identities_verified int, drift_findings int, failures int,
               stale_reason text, started_at timestamptz, last_batch_at timestamptz, completed_at timestamptz,
               last_clean_completed_at timestamptz, drift_open boolean, summary_eligible boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $verification_status$
  SELECT s.source_id, w.sweep_id, coalesce(w.state, 'NOT_STARTED'), w.phase, w.batches, w.scope_runs, w.runs_verified,
         w.unverifiable_runs, w.observations_verified, w.identities_verified, w.drift_findings,
         (SELECT count(*)::int FROM si.summary_sweep_failures f WHERE f.sweep_id = w.sweep_id),
         w.stale_reason, w.started_at, w.last_batch_at, w.completed_at,
         (SELECT max(c.completed_at) FROM si.summary_sweeps c WHERE c.source_id = s.source_id AND c.state = 'COMPLETED_CLEAN'),
         si.si_summary_drift_open(s.source_id), (SELECT v.eligible FROM si.si_summary_coverage(s.source_id) v)
    FROM si.sources s
    LEFT JOIN LATERAL (SELECT * FROM si.summary_sweeps x WHERE x.source_id = s.source_id ORDER BY x.sweep_id DESC LIMIT 1) w ON true
   ORDER BY s.source_id
$verification_status$;

------------------------------------------------------------------------------------------
-- Authorized recovery (owner only): clear open drift on the evidence of a COMPLETED_CLEAN sweep that started after every
-- DRIFT_DETECTED and REBUILT event of the source. The source row is locked FOR UPDATE so that no finding (whose insert
-- needs the FK's KEY SHARE on it) can commit between the check and the DRIFT_CLEARED event.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_summary_clear_drift(p_source_id text, p_sweep_id bigint)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $clear_drift$
DECLARE
  w record;
  ev bigint;
BEGIN
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
  INSERT INTO si.summary_events (source_id, kind) VALUES (p_source_id, 'DRIFT_CLEARED') RETURNING event_id INTO ev;
  INSERT INTO si.summary_drift_clearances (event_id, source_id, sweep_id) VALUES (ev, p_source_id, p_sweep_id);
  RETURN ev;
END $clear_drift$;

------------------------------------------------------------------------------------------
-- Privileges: tables owner-only; si_monitor executes the verifier, the failure record, expiry and the status only.
------------------------------------------------------------------------------------------
REVOKE ALL ON si.summary_sweeps, si.summary_sweep_batches, si.summary_sweep_runs, si.summary_sweep_identities,
  si.summary_sweep_failures, si.summary_drift_clearances FROM PUBLIC;
REVOKE ALL ON FUNCTION si.trg_sweep_records_append_only(), si.trg_summary_sweep_transition(), si.si_sweep_verify_run(uuid, text, int),
  si.si_summary_sweep_start(text, interval), si.si_summary_sweep_batch(bigint, int, int, int, int),
  si.si_summary_sweep_record_failure(bigint, int, text, text), si.si_summary_sweep_expire(interval),
  si.si_summary_verification_status(), si.si_summary_clear_drift(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_summary_sweep_start(text, interval), si.si_summary_sweep_batch(bigint, int, int, int, int),
  si.si_summary_sweep_record_failure(bigint, int, text, text), si.si_summary_sweep_expire(interval),
  si.si_summary_verification_status() TO si_monitor;
