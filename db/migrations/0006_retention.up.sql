-- B-002 migration 0006: Milestone 3 part 3A — deterministic retention enforcement and safe purge
-- (synthetic sources only). Contract: docs/b002-m3-design.md section 12.
--
--   - effective retention end: least(retain_until, si_retention_end(source, collected version)),
--     evaluated when it is used (purge, transition, status), never cached;
--   - completed-run retention metadata is immutable except RETAINED -> PURGED, which is allowed only
--     once the effective end has passed (data-based, not a session flag);
--   - evidence DELETE is admitted only for observations of a PURGED run and for ad identities that
--     no observation references; UPDATE and TRUNCATE stay forbidden for every role;
--   - si_purge_due: the only purge path (SECURITY DEFINER, EXECUTE for si_retention only), one source
--     per transaction, serialized against completion, rights changes and source controls;
--   - content-free, append-only purge audit (si.purge_log) and failure records (si.purge_failures);
--   - deferred checks: a PURGED run holds no evidence and is audited; no identity is left orphaned;
--   - content-free retention status for monitoring.
-- Source retirement alone does not end retention. No read path, no content serving.
--
-- Lock order (ranks of docs/b002-m2-plan.md and docs/b002-m3-design.md):
--   1 advisory -> 3 sources -> 4 runs (run_id order) -> 5 ads (sorted) -> 6 observations -> purge records.
--   The purge takes the source row FOR NO KEY UPDATE, which conflicts with T2 (FOR SHARE), with the
--   rights and control writers (FOR UPDATE) and with another purge, but not with T1 (FOR KEY SHARE).
--   Inside that exclusive section it deletes observations (6) before ad identities (5): the one
--   documented exception to the ascending order, safe because the only other writer of a source's
--   evidence (T2) is excluded by the rank-3 lock, and FK RESTRICT requires that order.

------------------------------------------------------------------------------------------
-- Index: identity lookups by FK RESTRICT, the identity checks and the purge (also fixes the
-- sequential scan of 0005's trg_ad_has_observation).
------------------------------------------------------------------------------------------
CREATE INDEX observations_by_ad ON si.observations (ad_id);

------------------------------------------------------------------------------------------
-- Effective retention end, cleanup deadline and reason (SECURITY INVOKER, granted to no role).
------------------------------------------------------------------------------------------
-- The stored deadline bounds the period; rights events and TERMINATE_RETENTION can only shorten
-- it (least() ignores a NULL "no end yet"). Retirement is not a term. Once reached, the end cannot
-- move later: rights versions cannot be back-dated and controls are append-only.
CREATE FUNCTION si.si_effective_retention_end(p_source_id text, p_version int, p_retain_until timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT least(p_retain_until, si.si_retention_end(p_source_id, p_version))
$$;

-- The stricter applicable cleanup target: the smallest cleanup_within of the collected version and
-- of every later version in effect by the end. A latency target, never a permission.
CREATE FUNCTION si.si_cleanup_due_by(p_source_id text, p_version int, p_end timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_end + min(v.cleanup_within)
    FROM si.rights_versions v
   WHERE v.source_id = p_source_id
     AND (v.version = p_version OR (v.version > p_version AND v.effective_from <= p_end))
$$;

CREATE FUNCTION si.si_retention_end_reason(p_source_id text, p_version int, p_retain_until timestamptz)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN t.at IS NOT NULL AND t.at <= least(p_retain_until, e.at) THEN 'TERMINATED'
           WHEN e.at IS NOT NULL AND e.at < p_retain_until THEN 'RIGHTS_ENDED'
           ELSE 'RETENTION_PERIOD'
         END
    FROM (SELECT si.si_retention_end(p_source_id, p_version) AS at) e,
         (SELECT min(c.occurred_at) AS at FROM si.source_controls c
           WHERE c.source_id = p_source_id AND c.kind = 'TERMINATE_RETENTION' AND c.through_version >= p_version) t
$$;

------------------------------------------------------------------------------------------
-- Retention state machine for finished runs. Fires before trg_runs_transition (name order); a
-- RUNNING row is left to the T2/T3/reaper rules of 0002-0005.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.trg_runs_retention() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $run_retention$
DECLARE
  now_at timestamptz;
  ver int;
  ends timestamptz;
BEGIN
  IF OLD.status = 'RUNNING' THEN
    RETURN NEW;
  END IF;
  IF ROW(NEW.retention_state, NEW.retain_until, NEW.first_purged_at, NEW.purged_at)
     IS NOT DISTINCT FROM ROW(OLD.retention_state, OLD.retain_until, OLD.first_purged_at, OLD.purged_at) THEN
    RETURN NEW;
  END IF;
  IF OLD.retention_state = 'RETAINED' AND NEW.retention_state = 'PURGED'
     AND NEW.retain_until IS NOT DISTINCT FROM OLD.retain_until THEN
    SELECT v.version INTO ver FROM si.rights_versions v WHERE v.rights_version_id = OLD.rights_version_id;
    now_at := clock_timestamp();
    ends := si.si_effective_retention_end(OLD.source_id, ver, OLD.retain_until);
    IF ends IS NULL OR ends > now_at THEN
      RAISE EXCEPTION 'SI_RETENTION_NOT_DUE: run % is still within its retention period', OLD.run_id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.first_purged_at := now_at;                       -- server-set, never taken from the caller
    NEW.purged_at := now_at;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SI_RETENTION_IMMUTABLE: retention metadata of finished run % allows only RETAINED -> PURGED', OLD.run_id
    USING ERRCODE = 'check_violation';
END $run_retention$;

CREATE TRIGGER trg_runs_retention BEFORE UPDATE ON si.collection_runs
FOR EACH ROW EXECUTE FUNCTION si.trg_runs_retention();

------------------------------------------------------------------------------------------
-- Evidence guard (replaces the 0005 body; same triggers). Data-based admission, no session flag:
--   observations: DELETE only when the run is PURGED (reachable only through the state machine
--                 above, which requires the effective end to have passed);
--   ads:          DELETE only when no observation references the identity (checked before the
--                 FK RESTRICT check, whose error detail would quote the key);
--   anything else, UPDATE and TRUNCATE: refused for every role, including si_owner.
------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION si.trg_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $evidence_guard$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' AND TG_TABLE_SCHEMA = 'si' THEN
    IF TG_TABLE_NAME = 'observations' THEN
      IF EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = OLD.run_id AND r.retention_state = 'PURGED') THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'ads' THEN
      IF NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = OLD.ad_id) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'SI_EVIDENCE_IMMUTABLE: evidence cannot be changed or removed' USING ERRCODE = '23514';
END $evidence_guard$;

------------------------------------------------------------------------------------------
-- Content-free purge audit and failure records (append-only for every role).
------------------------------------------------------------------------------------------
CREATE TABLE si.purge_log (
  purge_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id              uuid NOT NULL,
  run_id                uuid NOT NULL UNIQUE,
  source_id             text NOT NULL,
  rights_version_id     bigint NOT NULL,
  reason                text NOT NULL CHECK (reason IN ('RETENTION_PERIOD', 'RIGHTS_ENDED', 'TERMINATED')),
  effective_end         timestamptz NOT NULL,
  due_by                timestamptz NOT NULL,
  purged_at             timestamptz NOT NULL,
  observations_deleted  int NOT NULL CHECK (observations_deleted >= 1 AND observations_deleted <= 500),
  identities_deleted    int NOT NULL CHECK (identities_deleted >= 0 AND identities_deleted <= 500),
  late                  boolean NOT NULL,
  purged_by             text NOT NULL CHECK (purged_by ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CONSTRAINT purge_log_run FOREIGN KEY (run_id, source_id, rights_version_id)
    REFERENCES si.collection_runs (run_id, source_id, rights_version_id),
  CONSTRAINT purge_log_times CHECK (effective_end <= purged_at AND effective_end <= due_by),
  CONSTRAINT purge_log_late CHECK (late = (purged_at > due_by))
);

CREATE TABLE si.purge_failures (
  failure_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  code         text NOT NULL CHECK (code IN ('LOCK_TIMEOUT', 'STATEMENT_TIMEOUT', 'ISOLATION', 'INTEGRITY',
                                             'PRIVILEGE', 'CONNECTION', 'INTERNAL')),
  sqlstate     text CHECK (sqlstate ~ '^[0-9A-Z]{5}$'),
  recorded_by  text NOT NULL CHECK (recorded_by ~ '^[a-z_][a-z0-9_]{0,62}$')
);

CREATE FUNCTION si.trg_purge_records_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $purge_records_guard$
BEGIN
  RAISE EXCEPTION 'SI_PURGE_RECORD_IMMUTABLE: purge records cannot be changed or removed' USING ERRCODE = '23514';
END $purge_records_guard$;

CREATE TRIGGER trg_purge_log_append_only BEFORE UPDATE OR DELETE ON si.purge_log
FOR EACH ROW EXECUTE FUNCTION si.trg_purge_records_append_only();
CREATE TRIGGER trg_purge_log_no_truncate BEFORE TRUNCATE ON si.purge_log
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_purge_records_append_only();
CREATE TRIGGER trg_purge_failures_append_only BEFORE UPDATE OR DELETE ON si.purge_failures
FOR EACH ROW EXECUTE FUNCTION si.trg_purge_records_append_only();
CREATE TRIGGER trg_purge_failures_no_truncate BEFORE TRUNCATE ON si.purge_failures
FOR EACH STATEMENT EXECUTE FUNCTION si.trg_purge_records_append_only();

------------------------------------------------------------------------------------------
-- Deferred integrity (COMMIT). SECURITY DEFINER because deferred checks fire as the session role;
-- read-only. Together: PURGED <=> no evidence left for the run, every purge is audited exactly as
-- it happened, and no identity is left without evidence.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.trg_runs_purge_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $run_purge_check$
BEGIN
  IF EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'SI_PURGE_INCOMPLETE: run % is PURGED but still holds evidence', NEW.run_id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM si.purge_log p WHERE p.run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'SI_PURGE_UNAUDITED: run % was purged without an audit record', NEW.run_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $run_purge_check$;

CREATE CONSTRAINT TRIGGER trg_runs_purge_check AFTER UPDATE ON si.collection_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.retention_state = 'PURGED' AND OLD.retention_state IS DISTINCT FROM 'PURGED')
EXECUTE FUNCTION si.trg_runs_purge_check();

CREATE FUNCTION si.trg_observation_purge_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $observation_purge_check$
BEGIN
  IF EXISTS (SELECT 1 FROM si.ads a WHERE a.ad_id = OLD.ad_id)
     AND NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = OLD.ad_id) THEN
    RAISE EXCEPTION 'SI_PURGE_ORPHAN_IDENTITY: an ad identity was left without evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $observation_purge_check$;

CREATE CONSTRAINT TRIGGER trg_observation_purge_check AFTER DELETE ON si.observations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION si.trg_observation_purge_check();

CREATE FUNCTION si.trg_purge_log_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $purge_log_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM si.collection_runs r
                  WHERE r.run_id = NEW.run_id AND r.retention_state = 'PURGED'
                    AND r.published_count = NEW.observations_deleted AND r.purged_at = NEW.purged_at) THEN
    RAISE EXCEPTION 'SI_PURGE_LOG_MISMATCH: purge record % does not match its run', NEW.purge_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $purge_log_check$;

CREATE CONSTRAINT TRIGGER trg_purge_log_check AFTER INSERT ON si.purge_log
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION si.trg_purge_log_check();

------------------------------------------------------------------------------------------
-- si_purge_due: one bounded batch for one source (at most 20 runs, so at most 10,000 observations). Returns counts and a status code only:
--   PURGED       runs were purged (counts > 0);
--   NOTHING_DUE  no RETAINED run has passed its effective end;
--   BUSY         due evidence exists, but every such source is locked by a completion, a rights or
--                control change, or another purge (SKIP LOCKED: no convoy, retried by the next call).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_purge_due(p_limit int DEFAULT 10)
RETURNS TABLE (outcome text, purged_source text, runs_purged int, observations_purged int,
               identities_purged int, late_runs int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $purge_due$
DECLARE
  cand text;
  locked text;
  due_any boolean := false;
  batch uuid := gen_random_uuid();
  runs uuid[];
  g_runs uuid[];
  g_ads bigint[];
  dead bigint[];
  moved int;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: purge requires READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: purge limit must be between 1 and 20' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Candidate sources, earliest effective end first (no lock yet; re-evaluated after locking).
  -- The rights term is constant per (source, collected version), so it is computed once per pair.
  FOR cand IN
    SELECT d.source_id FROM (
      SELECT sv.source_id, min(si.si_effective_retention_end(sv.source_id, sv.version, sv.first_until)) AS ends
        FROM (SELECT r.source_id, v.version, min(r.retain_until) AS first_until
                FROM si.collection_runs r JOIN si.rights_versions v ON v.rights_version_id = r.rights_version_id
               WHERE r.retention_state = 'RETAINED'
               GROUP BY r.source_id, v.version) sv
       GROUP BY sv.source_id) d
     WHERE d.ends <= clock_timestamp()
     ORDER BY d.ends, d.source_id
  LOOP
    due_any := true;
    PERFORM 1 FROM si.sources s WHERE s.source_id = cand FOR NO KEY UPDATE SKIP LOCKED;      -- rank 3
    IF FOUND THEN
      locked := cand;
      EXIT;
    END IF;
  END LOOP;
  IF locked IS NULL THEN
    RETURN QUERY SELECT CASE WHEN due_any THEN 'BUSY' ELSE 'NOTHING_DUE' END, NULL::text, 0, 0, 0, 0;
    RETURN;
  END IF;

  -- Re-evaluated under the source lock: a new statement, so under READ COMMITTED it sees every rights
  -- version and control committed before the lock was granted; none can commit while it is held.
  SELECT array_agg(x.run_id ORDER BY x.run_id) INTO runs
    FROM (SELECT r.run_id
            FROM si.collection_runs r JOIN si.rights_versions v ON v.rights_version_id = r.rights_version_id
           WHERE r.source_id = locked AND r.retention_state = 'RETAINED'
             AND si.si_effective_retention_end(r.source_id, v.version, r.retain_until) <= clock_timestamp()
           ORDER BY si.si_effective_retention_end(r.source_id, v.version, r.retain_until), r.run_id
           LIMIT p_limit) x;
  IF runs IS NULL THEN
    RETURN QUERY SELECT 'NOTHING_DUE'::text, locked, 0, 0, 0, 0;
    RETURN;
  END IF;
  PERFORM 1 FROM si.collection_runs r WHERE r.run_id = ANY (runs) ORDER BY r.run_id FOR UPDATE;     -- rank 4

  -- State first: trg_runs_retention re-verifies each effective end; the guard then admits the deletes.
  UPDATE si.collection_runs r SET retention_state = 'PURGED'
   WHERE r.run_id = ANY (runs) AND r.retention_state = 'RETAINED';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved <> cardinality(runs) THEN
    RAISE EXCEPTION 'SI_PURGE_INCONSISTENT: run state changed during the purge' USING ERRCODE = '23514';
  END IF;

  -- rank 6, then rank 5 (documented exception, under the exclusive rank-3 lock).
  WITH g AS (DELETE FROM si.observations o WHERE o.run_id = ANY (runs) RETURNING o.run_id, o.ad_id)
  SELECT array_agg(g.run_id), array_agg(g.ad_id) INTO g_runs, g_ads FROM g;
  IF EXISTS (SELECT 1 FROM si.collection_runs r
               LEFT JOIN (SELECT u.run_id, count(*)::int AS n FROM unnest(g_runs) AS u(run_id) GROUP BY u.run_id) k
                      ON k.run_id = r.run_id
              WHERE r.run_id = ANY (runs) AND coalesce(k.n, 0) <> r.published_count) THEN
    RAISE EXCEPTION 'SI_PURGE_INCONSISTENT: stored evidence does not match the published counts' USING ERRCODE = '23514';
  END IF;

  -- Identities whose last observation was just deleted: locked in ad_id order, re-checked, deleted.
  PERFORM 1 FROM si.ads a WHERE a.ad_id IN (SELECT DISTINCT u.ad_id FROM unnest(g_ads) AS u(ad_id))
   ORDER BY a.ad_id FOR UPDATE;                                                                    -- rank 5
  WITH d AS (DELETE FROM si.ads a
              WHERE a.ad_id IN (SELECT DISTINCT u.ad_id FROM unnest(g_ads) AS u(ad_id))
                AND NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = a.ad_id)
             RETURNING a.ad_id)
  SELECT array_agg(d.ad_id) INTO dead FROM d;

  -- Audit in the same transaction: ids, codes, times and counts only. Each deleted identity is
  -- attributed to the lowest run_id of this batch that referenced it.
  INSERT INTO si.purge_log (batch_id, run_id, source_id, rights_version_id, reason, effective_end, due_by, purged_at,
                            observations_deleted, identities_deleted, late, purged_by)
  SELECT batch, r.run_id, r.source_id, r.rights_version_id,
         si.si_retention_end_reason(r.source_id, v.version, r.retain_until),
         e.ends, si.si_cleanup_due_by(r.source_id, v.version, e.ends), r.purged_at, r.published_count,
         (SELECT count(*)::int FROM (SELECT DISTINCT ON (p.ad_id) p.ad_id, p.run_id
                                       FROM unnest(g_runs, g_ads) AS p(run_id, ad_id)
                                      WHERE p.ad_id = ANY (coalesce(dead, '{}'))
                                      ORDER BY p.ad_id, p.run_id) w
           WHERE w.run_id = r.run_id),
         r.purged_at > si.si_cleanup_due_by(r.source_id, v.version, e.ends), session_user
    FROM si.collection_runs r
    JOIN si.rights_versions v ON v.rights_version_id = r.rights_version_id
   CROSS JOIN LATERAL (SELECT si.si_effective_retention_end(r.source_id, v.version, r.retain_until) AS ends) e
   WHERE r.run_id = ANY (runs);

  RETURN QUERY SELECT 'PURGED'::text, locked, cardinality(runs), cardinality(g_runs), coalesce(cardinality(dead), 0),
    (SELECT count(*)::int FROM si.purge_log p WHERE p.batch_id = batch AND p.late);
END $purge_due$;

------------------------------------------------------------------------------------------
-- Failure records (the purge transaction itself rolls back, so the caller records the failure
-- afterwards, in its own transaction, as a fixed code and SQLSTATE only).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_record_purge_failure(p_code text, p_sqlstate text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $purge_failure$
DECLARE
  id bigint;
BEGIN
  IF p_code IS NULL OR p_code NOT IN ('LOCK_TIMEOUT', 'STATEMENT_TIMEOUT', 'ISOLATION', 'INTEGRITY', 'PRIVILEGE',
                                      'CONNECTION', 'INTERNAL')
     OR (p_sqlstate IS NOT NULL AND p_sqlstate !~ '^[0-9A-Z]{5}$') THEN
    RAISE EXCEPTION 'SI_BAD_ARGUMENT: unknown purge failure code or SQLSTATE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO si.purge_failures (code, sqlstate, recorded_by) VALUES (p_code, p_sqlstate, session_user)
  RETURNING failure_id INTO id;
  RETURN id;
END $purge_failure$;

------------------------------------------------------------------------------------------
-- Monitoring: content-free retention status and recent failures.
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_retention_status()
RETURNS TABLE (status_source text, retained_runs int, due_runs int, overdue_runs int, next_end timestamptz,
               oldest_overdue_due_by timestamptz, purged_runs int, late_purges int, last_purged_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $retention_status$
  WITH r AS (
    SELECT x.source_id, x.retention_state, e.ends,
           si.si_cleanup_due_by(x.source_id, v.version, e.ends) AS due_by
      FROM si.collection_runs x
      JOIN si.rights_versions v ON v.rights_version_id = x.rights_version_id
     CROSS JOIN LATERAL (SELECT si.si_effective_retention_end(x.source_id, v.version, x.retain_until) AS ends) e
     WHERE x.retention_state = 'RETAINED'),
  now_at AS (SELECT clock_timestamp() AS t),
  srcs AS (SELECT source_id FROM r UNION SELECT source_id FROM si.purge_log)
  SELECT s.source_id,
         (SELECT count(*)::int FROM r WHERE r.source_id = s.source_id),
         (SELECT count(*)::int FROM r, now_at WHERE r.source_id = s.source_id AND r.ends <= now_at.t),
         (SELECT count(*)::int FROM r, now_at WHERE r.source_id = s.source_id AND r.due_by < now_at.t),
         (SELECT min(r.ends) FROM r WHERE r.source_id = s.source_id),
         (SELECT min(r.due_by) FROM r, now_at WHERE r.source_id = s.source_id AND r.due_by < now_at.t),
         (SELECT count(*)::int FROM si.purge_log p WHERE p.source_id = s.source_id),
         (SELECT count(*)::int FROM si.purge_log p WHERE p.source_id = s.source_id AND p.late),
         (SELECT max(p.purged_at) FROM si.purge_log p WHERE p.source_id = s.source_id)
    FROM srcs s
   ORDER BY s.source_id
$retention_status$;

CREATE FUNCTION si.si_purge_failures(p_limit int DEFAULT 20)
RETURNS TABLE (failure_id bigint, occurred_at timestamptz, code text, sqlstate text, recorded_by text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $purge_failures$
  SELECT f.failure_id, f.occurred_at, f.code, f.sqlstate, f.recorded_by
    FROM si.purge_failures f
   ORDER BY f.failure_id DESC
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
$purge_failures$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC. No application role gains any privilege on si.ads or
-- si.observations; the purge is reachable only through si_purge_due (si_retention).
------------------------------------------------------------------------------------------
REVOKE ALL ON si.purge_log, si.purge_failures FROM PUBLIC;
GRANT SELECT ON si.purge_log, si.purge_failures TO si_retention;
REVOKE ALL ON FUNCTION
  si.si_effective_retention_end(text, int, timestamptz), si.si_cleanup_due_by(text, int, timestamptz),
  si.si_retention_end_reason(text, int, timestamptz), si.trg_runs_retention(), si.trg_purge_records_append_only(),
  si.trg_runs_purge_check(), si.trg_observation_purge_check(), si.trg_purge_log_check(),
  si.si_purge_due(int), si.si_record_purge_failure(text, text), si.si_retention_status(), si.si_purge_failures(int)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_purge_due(int), si.si_record_purge_failure(text, text) TO si_retention;
GRANT EXECUTE ON FUNCTION si.si_retention_status(), si.si_purge_failures(int) TO si_retention, si_monitor;
