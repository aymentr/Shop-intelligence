-- B-002 migration 0007: Milestone 3 part 3B — verified commit authorization (D8 groundwork) and a
-- fail-closed readability predicate. Synthetic sources only. Contract: docs/b002-m3-design.md §13.
--
-- A completion receipt never authorizes anything by itself. 0007 classifies each completed run with
-- evidence as VALID, INVALID or UNVERIFIABLE from PostgreSQL's own record of the completion transaction:
--   identity   every observation of the run and its receipt carry one and the same transaction id
--              (observations are never updated; receipts can no longer be updated, see below);
--   timestamp  pg_xact_commit_timestamp of that id (track_commit_timestamp = on, D7);
--   window     [rights version effective_from, least(si_window_end(version), source retired_at)).
-- VALID needs all three and a commit inside the window; INVALID is a commit proven outside it (or a
-- version that never allowed evaluation and retention); everything uncertain is UNVERIFIABLE.
-- The verdict is computed by the database (trigger) and never taken from a caller. Once recorded it
-- is immutable: later rights events cannot move a window end before their own recording time, so a
-- verdict cannot change (clock monotonicity assumed; see §13).
--
-- No reader role, no evidence SELECT grant, no read interface. si_evidence_readable is granted to no
-- role: it exists for a future migration, and requires the verdict AND the current authorization.
--
-- Lock order: the verifier takes no source lock (emergency controls never wait for it). Its only row
-- lock is the FK check's KEY SHARE on the run row (rank 4), then the verification insert.

------------------------------------------------------------------------------------------
-- Legacy receipt columns: never fabricated again. 0002 allowed the owner to set commit_ts and
-- within_validity once (to any value) and to insert them; both are now permanently NULL, and a
-- receipt cannot be updated at all, so its xmin stays the completion transaction's (identity witness).
------------------------------------------------------------------------------------------
ALTER TABLE si.publication_receipts
  ADD CONSTRAINT receipts_legacy_columns_unused CHECK (commit_ts IS NULL AND within_validity IS NULL);

CREATE OR REPLACE FUNCTION si.trg_receipts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $receipt_guard$
BEGIN
  RAISE EXCEPTION 'SI_RECEIPT_IMMUTABLE: publication receipts cannot be changed or removed' USING ERRCODE = '23514';
END $receipt_guard$;

------------------------------------------------------------------------------------------
-- Purge audit label (M3-P3A follow-up): a stored deadline that T2 already shortened to a rights
-- event (expiry, revocation) is RIGHTS_ENDED, not RETENTION_PERIOD. Same signature and result type.
------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION si.si_retention_end_reason(p_source_id text, p_version int, p_retain_until timestamptz)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN t.at IS NOT NULL AND t.at <= least(p_retain_until, e.at) THEN 'TERMINATED'
           WHEN e.at IS NOT NULL AND e.at < p_retain_until THEN 'RIGHTS_ENDED'
           WHEN EXISTS (SELECT 1 FROM si.rights_versions v
                         WHERE v.source_id = p_source_id AND v.version >= p_version
                           AND ((v.retain = 'ALLOWED' AND v.expires_at = p_retain_until)
                             OR (v.retain <> 'ALLOWED' AND v.version > p_version AND v.effective_from = p_retain_until)))
             THEN 'RIGHTS_ENDED'
           ELSE 'RETENTION_PERIOD'
         END
    FROM (SELECT si.si_retention_end(p_source_id, p_version) AS at) e,
         (SELECT min(c.occurred_at) AS at FROM si.source_controls c
           WHERE c.source_id = p_source_id AND c.kind = 'TERMINATE_RETENTION' AND c.through_version >= p_version) t
$$;

------------------------------------------------------------------------------------------
-- Constants and the commit-timestamp lookup (one place each; granted to no role).
------------------------------------------------------------------------------------------
-- Largest transaction-id age at which an identity is still trusted: far below the freeze horizon
-- (autovacuum_freeze_max_age, default 200 million), where commit timestamps are truncated and a raw
-- 32-bit xmin could later alias a newer transaction after wraparound.
CREATE FUNCTION si.si_verification_max_xid_age() RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 100000000::bigint $$;

-- Operational target for verification lag (not a correctness guarantee).
CREATE FUNCTION si.si_verification_lag_target() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT interval '60 seconds' $$;

CREATE FUNCTION si.si_commit_ts(p_xid xid) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT pg_catalog.pg_xact_commit_timestamp(p_xid) $$;

------------------------------------------------------------------------------------------
-- The verdict (SECURITY INVOKER, granted to no role; used by the insert trigger only).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_receipt_verdict(p_run_id uuid)
RETURNS TABLE (verdict text, reason text, commit_xid bigint, commit_ts timestamptz, window_start timestamptz,
               window_end timestamptz, source_id text, rights_version_id bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $receipt_verdict$
DECLARE
  r record;
  v record;
  retired timestamptz;
  obs_n int;
  obs_k int;
  obs_x text;
  rx xid;
  ts timestamptz;
  now_at timestamptz := clock_timestamp();
BEGIN
  IF current_setting('track_commit_timestamp') IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SI_COMMIT_TS_DISABLED: track_commit_timestamp must be on to verify receipts'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT x.run_id, x.source_id, x.rights_version_id, x.status, x.published_count, x.finished_at INTO r
    FROM si.collection_runs x WHERE x.run_id = p_run_id;
  IF r.run_id IS NULL OR r.status IS DISTINCT FROM 'COMPLETED' OR r.published_count = 0 THEN
    RAISE EXCEPTION 'SI_VERIFY_NOT_APPLICABLE: run % is not a completed run with evidence', p_run_id
      USING ERRCODE = 'check_violation';
  END IF;
  source_id := r.source_id;
  rights_version_id := r.rights_version_id;
  SELECT vv.effective_from, vv.evaluation, vv.retain INTO v FROM si.rights_versions vv WHERE vv.rights_version_id = r.rights_version_id;
  SELECT s.retired_at INTO retired FROM si.sources s WHERE s.source_id = r.source_id;
  window_start := v.effective_from;
  window_end := least(si.si_window_end(r.rights_version_id), coalesce(retired, 'infinity'::timestamptz));

  SELECT count(*)::int, count(DISTINCT o.xmin::text)::int, min(o.xmin::text) INTO obs_n, obs_k, obs_x
    FROM si.observations o WHERE o.run_id = p_run_id;
  SELECT p.xmin INTO rx FROM si.publication_receipts p WHERE p.run_id = p_run_id;
  IF obs_n = 0 THEN
    verdict := 'UNVERIFIABLE'; reason := 'NO_EVIDENCE'; RETURN NEXT; RETURN;
  END IF;
  -- One transaction id across all observations, equal to the receipt's, and a normal id (>= 3).
  IF obs_k <> 1 OR rx IS NULL OR obs_x IS DISTINCT FROM rx::text OR obs_x::bigint < 3 THEN
    verdict := 'UNVERIFIABLE'; reason := 'IDENTITY_MISMATCH'; RETURN NEXT; RETURN;
  END IF;
  commit_xid := obs_x::bigint;
  IF pg_catalog.age(rx) > si.si_verification_max_xid_age() THEN
    verdict := 'UNVERIFIABLE'; reason := 'XID_TOO_OLD'; RETURN NEXT; RETURN;
  END IF;
  ts := si.si_commit_ts(rx);
  IF ts IS NULL THEN
    verdict := 'UNVERIFIABLE'; reason := 'NO_COMMIT_TIMESTAMP'; RETURN NEXT; RETURN;
  END IF;
  commit_ts := ts;
  -- The commit cannot precede T2's own clock reading, nor follow this one: anything else means the
  -- clock moved backwards (or the identity is not the completion's). Such a run is never VALID.
  IF ts < r.finished_at OR ts > now_at THEN
    verdict := 'UNVERIFIABLE'; reason := 'CLOCK_INCONSISTENT'; RETURN NEXT; RETURN;
  END IF;
  IF v.evaluation IS DISTINCT FROM 'ALLOWED' OR v.retain IS DISTINCT FROM 'ALLOWED' THEN
    verdict := 'INVALID'; reason := 'RIGHTS_NOT_ALLOWED';
  ELSIF ts < window_start THEN
    verdict := 'INVALID'; reason := 'COMMITTED_BEFORE_WINDOW';
  ELSIF ts >= window_end THEN
    verdict := 'INVALID'; reason := 'COMMITTED_AFTER_WINDOW';
  ELSE
    verdict := 'VALID'; reason := 'COMMITTED_IN_WINDOW';
  END IF;
  RETURN NEXT;
END $receipt_verdict$;

------------------------------------------------------------------------------------------
-- Verification records (append-only for every role; every field computed by the trigger).
------------------------------------------------------------------------------------------
CREATE TABLE si.receipt_verifications (
  run_id             uuid PRIMARY KEY,
  source_id          text NOT NULL,
  rights_version_id  bigint NOT NULL,
  verdict            text NOT NULL CHECK (verdict IN ('VALID', 'INVALID', 'UNVERIFIABLE')),
  reason             text NOT NULL CHECK (reason IN ('COMMITTED_IN_WINDOW', 'COMMITTED_AFTER_WINDOW', 'COMMITTED_BEFORE_WINDOW',
                                                     'RIGHTS_NOT_ALLOWED', 'NO_EVIDENCE', 'IDENTITY_MISMATCH', 'XID_TOO_OLD',
                                                     'NO_COMMIT_TIMESTAMP', 'CLOCK_INCONSISTENT')),
  commit_xid         bigint CHECK (commit_xid >= 3 AND commit_xid <= 4294967295),
  commit_ts          timestamptz,
  window_start       timestamptz NOT NULL,
  window_end         timestamptz NOT NULL,
  verified_at        timestamptz NOT NULL,
  verified_by        text NOT NULL CHECK (verified_by ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CONSTRAINT verifications_run FOREIGN KEY (run_id, source_id, rights_version_id)
    REFERENCES si.collection_runs (run_id, source_id, rights_version_id),
  CONSTRAINT verifications_valid CHECK ((verdict = 'VALID') = (reason = 'COMMITTED_IN_WINDOW')),
  CONSTRAINT verifications_valid_shape CHECK (verdict <> 'VALID' OR (commit_xid IS NOT NULL AND commit_ts IS NOT NULL
                                              AND commit_ts >= window_start AND commit_ts < window_end AND commit_ts <= verified_at)),
  CONSTRAINT verifications_invalid_shape CHECK (verdict <> 'INVALID' OR (reason IN ('COMMITTED_AFTER_WINDOW', 'COMMITTED_BEFORE_WINDOW',
                                                'RIGHTS_NOT_ALLOWED') AND commit_xid IS NOT NULL AND commit_ts IS NOT NULL)),
  CONSTRAINT verifications_after CHECK (reason <> 'COMMITTED_AFTER_WINDOW' OR commit_ts >= window_end),
  CONSTRAINT verifications_before CHECK (reason <> 'COMMITTED_BEFORE_WINDOW' OR commit_ts < window_start),
  CONSTRAINT verifications_unverifiable_shape CHECK (verdict <> 'UNVERIFIABLE' OR reason IN ('NO_EVIDENCE', 'IDENTITY_MISMATCH',
                                                     'XID_TOO_OLD', 'NO_COMMIT_TIMESTAMP', 'CLOCK_INCONSISTENT')),
  CONSTRAINT verifications_timestamp_known CHECK ((commit_ts IS NULL) = (reason IN ('NO_EVIDENCE', 'IDENTITY_MISMATCH', 'XID_TOO_OLD',
                                                  'NO_COMMIT_TIMESTAMP')))
);

-- Computed fields are never taken from the caller: an INSERT names a run, the database decides.
CREATE FUNCTION si.trg_verification_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $verification_insert$
DECLARE
  d record;
BEGIN
  SELECT * INTO d FROM si.si_receipt_verdict(NEW.run_id);
  NEW.source_id := d.source_id;
  NEW.rights_version_id := d.rights_version_id;
  NEW.verdict := d.verdict;
  NEW.reason := d.reason;
  NEW.commit_xid := d.commit_xid;
  NEW.commit_ts := d.commit_ts;
  NEW.window_start := d.window_start;
  NEW.window_end := d.window_end;
  NEW.verified_at := clock_timestamp();
  NEW.verified_by := session_user;
  RETURN NEW;
END $verification_insert$;

CREATE TRIGGER trg_verification_insert BEFORE INSERT ON si.receipt_verifications
FOR EACH ROW EXECUTE FUNCTION si.trg_verification_insert();

CREATE TABLE si.verification_failures (
  failure_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  code         text NOT NULL CHECK (code IN ('LOCK_TIMEOUT', 'STATEMENT_TIMEOUT', 'ISOLATION', 'INTEGRITY', 'PRIVILEGE',
                                             'COMMIT_TS_DISABLED', 'CONNECTION', 'INTERNAL')),
  sqlstate     text CHECK (sqlstate ~ '^[0-9A-Z]{5}$'),
  recorded_by  text NOT NULL CHECK (recorded_by ~ '^[a-z_][a-z0-9_]{0,62}$')
);

CREATE FUNCTION si.trg_verification_records_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $verification_records_guard$
BEGIN
  RAISE EXCEPTION 'SI_VERIFICATION_IMMUTABLE: verification records cannot be changed or removed' USING ERRCODE = '23514';
END $verification_records_guard$;

CREATE TRIGGER trg_verifications_append_only BEFORE UPDATE OR DELETE ON si.receipt_verifications
FOR EACH ROW EXECUTE FUNCTION si.trg_verification_records_append_only();
CREATE TRIGGER trg_verifications_no_truncate BEFORE TRUNCATE ON si.receipt_verifications
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_verification_records_append_only();
CREATE TRIGGER trg_verification_failures_append_only BEFORE UPDATE OR DELETE ON si.verification_failures
FOR EACH ROW EXECUTE FUNCTION si.trg_verification_records_append_only();
CREATE TRIGGER trg_verification_failures_no_truncate BEFORE TRUNCATE ON si.verification_failures
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_verification_records_append_only();

-- Pending-verification scan: completed runs with evidence, oldest first.
CREATE INDEX runs_verification_pending ON si.collection_runs (finished_at, run_id)
  WHERE status = 'COMPLETED' AND published_count > 0;

------------------------------------------------------------------------------------------
-- si_verify_receipts: one bounded, idempotent batch. Counts only.
--   VERIFIED         rows were recorded;
--   NOTHING_PENDING  every completed run with evidence already has a verdict.
-- Concurrency: no candidate is locked; the primary key and ON CONFLICT DO NOTHING make concurrent
-- verifiers record each run exactly once (a second inserter waits for the first, then skips).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_verify_receipts(p_limit int DEFAULT 100)
RETURNS TABLE (outcome text, verified int, valid int, invalid int, unverifiable int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $verify_receipts$
DECLARE
  cands uuid[];
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: verification requires READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: verification limit must be between 1 and 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF current_setting('track_commit_timestamp') IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SI_COMMIT_TS_DISABLED: track_commit_timestamp must be on to verify receipts'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT array_agg(x.run_id ORDER BY x.finished_at, x.run_id) INTO cands
    FROM (SELECT r.run_id, r.finished_at FROM si.collection_runs r
           WHERE r.status = 'COMPLETED' AND r.published_count > 0
             AND NOT EXISTS (SELECT 1 FROM si.receipt_verifications v WHERE v.run_id = r.run_id)
           ORDER BY r.finished_at, r.run_id
           LIMIT p_limit) x;
  IF cands IS NULL THEN
    RETURN QUERY SELECT 'NOTHING_PENDING'::text, 0, 0, 0, 0;
    RETURN;
  END IF;
  RETURN QUERY
  WITH ins AS (
    INSERT INTO si.receipt_verifications (run_id)
    SELECT u.run_id FROM unnest(cands) AS u(run_id)
    ON CONFLICT (run_id) DO NOTHING
    RETURNING receipt_verifications.verdict)
  SELECT 'VERIFIED'::text, count(*)::int, (count(*) FILTER (WHERE ins.verdict = 'VALID'))::int,
         (count(*) FILTER (WHERE ins.verdict = 'INVALID'))::int, (count(*) FILTER (WHERE ins.verdict = 'UNVERIFIABLE'))::int
    FROM ins;
END $verify_receipts$;

CREATE FUNCTION si.si_record_verification_failure(p_code text, p_sqlstate text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $verification_failure$
DECLARE
  id bigint;
BEGIN
  IF p_code IS NULL OR p_code NOT IN ('LOCK_TIMEOUT', 'STATEMENT_TIMEOUT', 'ISOLATION', 'INTEGRITY', 'PRIVILEGE',
                                      'COMMIT_TS_DISABLED', 'CONNECTION', 'INTERNAL')
     OR (p_sqlstate IS NOT NULL AND p_sqlstate !~ '^[0-9A-Z]{5}$') THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: unknown verification failure code or SQLSTATE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO si.verification_failures (code, sqlstate, recorded_by) VALUES (p_code, p_sqlstate, session_user)
  RETURNING failure_id INTO id;
  RETURN id;
END $verification_failure$;

------------------------------------------------------------------------------------------
-- Monitoring (content-free).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_verification_status()
RETURNS TABLE (pending int, valid int, invalid int, unverifiable int, oldest_pending_finished_at timestamptz,
               oldest_pending_age_seconds bigint, lag_target_seconds int, lag_exceeded boolean, max_pending_xid_age bigint,
               xid_age_warning boolean, failures_24h int, last_failure_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $verification_status$
  WITH p AS (
    SELECT r.finished_at, pg_catalog.age(rc.xmin)::bigint AS xid_age
      FROM si.collection_runs r
      LEFT JOIN si.publication_receipts rc ON rc.run_id = r.run_id
     WHERE r.status = 'COMPLETED' AND r.published_count > 0
       AND NOT EXISTS (SELECT 1 FROM si.receipt_verifications v WHERE v.run_id = r.run_id)),
  t AS (SELECT clock_timestamp() AS now_at)
  SELECT (SELECT count(*)::int FROM p),
         (SELECT count(*)::int FROM si.receipt_verifications WHERE verdict = 'VALID'),
         (SELECT count(*)::int FROM si.receipt_verifications WHERE verdict = 'INVALID'),
         (SELECT count(*)::int FROM si.receipt_verifications WHERE verdict = 'UNVERIFIABLE'),
         (SELECT min(p.finished_at) FROM p),
         floor(extract(epoch FROM t.now_at - (SELECT min(p.finished_at) FROM p)))::bigint,
         extract(epoch FROM si.si_verification_lag_target())::int,
         coalesce(t.now_at - (SELECT min(p.finished_at) FROM p) > si.si_verification_lag_target(), false),
         (SELECT max(p.xid_age) FROM p),
         coalesce((SELECT max(p.xid_age) > si.si_verification_max_xid_age() / 2 FROM p), false),
         (SELECT count(*)::int FROM si.verification_failures f, t WHERE f.occurred_at > t.now_at - interval '24 hours'),
         (SELECT max(f.occurred_at) FROM si.verification_failures f)
    FROM t
$verification_status$;

CREATE FUNCTION si.si_verification_failures(p_limit int DEFAULT 20)
RETURNS TABLE (failure_id bigint, occurred_at timestamptz, code text, sqlstate text, recorded_by text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $verification_failures$
  SELECT f.failure_id, f.occurred_at, f.code, f.sqlstate, f.recorded_by
    FROM si.verification_failures f
   ORDER BY f.failure_id DESC
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
$verification_failures$;

------------------------------------------------------------------------------------------
-- Fail-closed readability predicate for a FUTURE read path (granted to no role; reads nothing out).
-- The stored verdict is necessary, never sufficient: current authorization is re-evaluated now.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_evidence_readable(p_run_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $evidence_readable$
  SELECT coalesce((
    SELECT rv.verdict = 'VALID'
       AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
       AND s.evidence_kind = 'SYNTHETIC'
       -- source state: not retired (nor retiring within the margin), not suspended, not terminated
       AND (s.retired_at IS NULL OR n.t + si.si_publish_margin() < s.retired_at)
       AND NOT si.si_source_suspended(r.source_id)
       AND NOT si.si_retention_terminated(r.source_id, v.version)
       -- active retention
       AND n.t + si.si_publish_margin() < si.si_effective_retention_end(r.source_id, v.version, r.retain_until)
       -- current rights: the version in effect now allows evaluation and retention and is not expiring
       AND EXISTS (SELECT 1 FROM si.rights_versions cur
                    WHERE cur.source_id = r.source_id AND cur.effective_from <= n.t
                      AND cur.version = (SELECT max(m.version) FROM si.rights_versions m
                                          WHERE m.source_id = r.source_id AND m.effective_from <= n.t)
                      AND cur.evaluation = 'ALLOWED' AND cur.retain = 'ALLOWED'
                      AND n.t + si.si_publish_margin() < si.si_window_end(cur.rights_version_id))
       -- current source authorization: every network of the evidence is still supported
       AND NOT EXISTS (SELECT 1 FROM si.observations o
                        WHERE o.run_id = r.run_id AND NOT (o.network = ANY (s.supported_networks)))
      FROM si.collection_runs r
      JOIN si.receipt_verifications rv ON rv.run_id = r.run_id
      JOIN si.rights_versions v ON v.rights_version_id = r.rights_version_id
      JOIN si.sources s ON s.source_id = r.source_id
     CROSS JOIN (SELECT clock_timestamp() AS t) n
     WHERE r.run_id = p_run_id), false)
$evidence_readable$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC; no evidence privilege for any role; no table grant on the new
-- tables (status through functions); EXECUTE only for si_monitor.
------------------------------------------------------------------------------------------
REVOKE ALL ON si.receipt_verifications, si.verification_failures FROM PUBLIC;
REVOKE ALL ON FUNCTION
  si.si_verification_max_xid_age(), si.si_verification_lag_target(), si.si_commit_ts(xid), si.si_receipt_verdict(uuid),
  si.trg_verification_insert(), si.trg_verification_records_append_only(), si.si_verify_receipts(int),
  si.si_record_verification_failure(text, text), si.si_verification_status(), si.si_verification_failures(int),
  si.si_evidence_readable(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_verify_receipts(int), si.si_record_verification_failure(text, text),
  si.si_verification_status(), si.si_verification_failures(int) TO si_monitor;
