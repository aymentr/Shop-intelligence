-- B-002 migration 0011: M4-P1 — reader source status for advertiser freshness and reliability (synthetic only).
-- Contract: docs/b002-m4-intelligence.md. Migrations 0001-0010 unchanged; si_read_evidence is not modified.
--
-- Why: the internal reader can obtain evidence pages (si_read_evidence) but no collection metadata, so
-- collection freshness, coverage and verification completeness cannot be computed. This adds ONE reader
-- function that returns content-free counts and timestamps for one source and one period, and nothing else:
-- no advertising content, no identifiers, no run ids.
--
-- It is gated exactly like an evidence page:
--   - the same dedicated-principal, isolation and session checks (including synchronous_commit <> off);
--   - a committed, crash-durable read intent of this login (si_begin_read), whose audited scope binds the
--     source AND the period: cursor 'v1|<source>|status|<from>|<to>' (UTC, microseconds), limit 1.
--     si_begin_read already accepts this cursor; si_read_evidence rejects it (BAD_CURSOR), and this function
--     accepts no other cursor, so an evidence intent and a status intent can never be used for each other;
--   - the 0010 durability gate, copied verbatim into si_claim_read_intent (si_read_evidence keeps its own copy);
--   - under the source lock (FOR SHARE, rank 3, released before return): the active grant, and the source
--     must be available NOW — not suspended (TERMINATE_RETENTION also suspends), not retired, and current
--     rights allow evaluation and retention — otherwise SI_READ_SOURCE_UNAVAILABLE (55000);
--   - the intent is consumed and a completion row is written, like a page.
-- Evidence-derived values (latest verified evidence, readable runs, verified days) use si_evidence_readable,
-- so they respect verification (D8/G3), retention, suspension and rights exactly like evidence pages.

------------------------------------------------------------------------------------------
-- Intent claim (shared by the status function; SECURITY INVOKER: it runs with the caller's rights,
-- which is the owner's inside a SECURITY DEFINER caller, and nobody may execute it directly).
------------------------------------------------------------------------------------------
CREATE FUNCTION si.si_claim_read_intent(p_who text, p_source_id text, p_intent_id uuid, p_cursor text, p_limit int)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $claim_read_intent$
DECLARE
  it record;
  xid_of_intent xid8;
  st text;
  target pg_lsn;
  deadline timestamptz;
BEGIN
  -- Durability (M3-AUD-03), part 1: observe the creating transaction's commit BEFORE capturing the WAL
  -- target, and before touching si.read_intents (a heap access can insert WAL, e.g. pruning). Once
  -- pg_xact_status reports 'committed', the commit record has been inserted, so the insert position read
  -- afterwards is at or past its end.
  BEGIN
    xid_of_intent := ('x' || substr(replace(p_intent_id::text, '-', ''), 1, 16))::bit(64)::bigint::text::xid8;
    st := pg_xact_status(xid_of_intent);
  EXCEPTION WHEN OTHERS THEN                         -- malformed, foreign or out-of-range: fail closed (never catches cancel)
    st := NULL;
  END;
  IF p_intent_id IS NULL OR st IS NULL OR st = 'aborted' THEN
    RAISE EXCEPTION 'SI_READ_INTENT_INVALID: no matching read intent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF st <> 'committed' THEN
    RAISE EXCEPTION 'SI_READ_INTENT_UNCOMMITTED: the read intent must be committed first' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF pg_is_in_recovery() THEN
    RAISE EXCEPTION 'SI_READ_INTENT_NOT_DURABLE: durability cannot be established' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  target := pg_current_wal_insert_lsn();

  -- The committed audit record must exist before anything is decided about evidence.
  SELECT i.principal, i.source_id, i.cursor_sha256, i.read_limit, i.state, i.expires_at, i.created_xid INTO it
    FROM si.read_intents i WHERE i.intent_id = p_intent_id;
  IF it.principal IS NULL OR it.principal IS DISTINCT FROM p_who OR it.source_id IS DISTINCT FROM p_source_id
     OR it.read_limit IS DISTINCT FROM p_limit OR it.cursor_sha256 IS DISTINCT FROM si.si_read_cursor_digest(p_cursor)
     OR it.created_xid IS DISTINCT FROM xid_of_intent THEN
    RAISE EXCEPTION 'SI_READ_INTENT_INVALID: no matching read intent' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF it.state <> 'OPEN' THEN
    RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF it.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'SI_READ_INTENT_EXPIRED: the read intent expired' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Durability, part 2: release nothing until WAL is flushed (fsync) past the target, hence past the intent's
  -- commit record. Bounded; fails closed. No lock is held while waiting.
  deadline := clock_timestamp() + interval '1 second';
  WHILE pg_current_wal_flush_lsn() < target LOOP
    IF clock_timestamp() >= deadline THEN
      RAISE EXCEPTION 'SI_READ_INTENT_NOT_DURABLE: the read intent is not yet durable; start a new read' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM pg_sleep(0.005);
  END LOOP;
END $claim_read_intent$;

------------------------------------------------------------------------------------------
-- Source status for one period.
------------------------------------------------------------------------------------------
CREATE TYPE si.source_status_row AS (
  source_id                         text,
  period_from                       timestamptz,
  period_to                         timestamptz,
  as_of                             timestamptz,
  latest_successful_collection_at   timestamptz,   -- any COMPLETED run (EMPTY included), any time
  latest_verified_evidence_at       timestamptz,   -- latest run that is readable now (si_evidence_readable)
  runs_completed                    int,           -- in the period (finished_at in [from, to))
  runs_failed                       int,
  runs_empty                        int,           -- completed, nothing published
  runs_with_evidence                int,           -- completed, something published
  runs_verified_valid               int,
  runs_verified_invalid             int,
  runs_verified_unverifiable        int,
  runs_verification_pending         int,
  runs_readable                     int,           -- readable now
  runs_purged                       int,           -- evidence no longer retained
  days_in_period                    int,           -- UTC calendar days overlapping the period
  days_with_collection              int,
  days_with_verified_evidence       int
);

CREATE FUNCTION si.si_read_source_status(p_source_id text, p_intent_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS SETOF si.source_status_row
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $read_source_status$
DECLARE
  who text := session_user;
  problem text;
  cur text;
  available boolean;
  out_row si.source_status_row;
  bytes int;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'SI_ISOLATION: reads require READ COMMITTED' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  -- Identity first: a session that is not a dedicated reader learns nothing else.
  IF p_source_id IS NULL OR p_source_id !~ '^[a-z0-9][a-z0-9-]{1,62}$' OR NOT si.si_reader_principal_ok(who) THEN
    RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  problem := coalesce(si.si_reader_session_problem(),
                      CASE WHEN current_setting('synchronous_commit') = 'off' THEN 'synchronous_commit' END);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'SI_READ_UNSAFE_SESSION: %', problem USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '366 days'
     OR p_from <> date_trunc('milliseconds', p_from) OR p_to <> date_trunc('milliseconds', p_to) THEN
    RAISE EXCEPTION 'SI_READ_BAD_ARGUMENT: the period must be [from, to) with from < to, at most 366 days, millisecond precision'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  cur := 'v1|' || p_source_id || '|status|'
         || to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
         || to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  -- The committed, crash-durable request record for exactly this source and period (0010 gate).
  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, 1);

  BEGIN
    PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR SHARE;                -- rank 3
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g
                                 WHERE g.principal = who AND g.source_id = p_source_id AND g.revoked_at IS NULL
                                   AND g.purpose = 'INTERNAL_SYNTHETIC_EVALUATION') THEN
      RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
    END IF;
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
      INTO available
      FROM si.sources s CROSS JOIN (SELECT clock_timestamp() AS t) n
     WHERE s.source_id = p_source_id;
    IF available IS NOT TRUE THEN
      RAISE EXCEPTION 'SI_READ_SOURCE_UNAVAILABLE: the source is suspended, terminated, retired or not authorized for evaluation'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    WITH runs AS (
      SELECT r.run_id, r.status, r.finished_at, r.published_count, r.retention_state,
             (r.finished_at >= p_from AND r.finished_at < p_to) AS in_period,
             (r.status = 'COMPLETED' AND r.published_count > 0 AND si.si_evidence_readable(r.run_id)) AS readable,
             (SELECT rv.verdict FROM si.receipt_verifications rv WHERE rv.run_id = r.run_id) AS verdict
        FROM si.collection_runs r
       WHERE r.source_id = p_source_id AND r.status IN ('COMPLETED', 'FAILED'))
    SELECT p_source_id, p_from, p_to, clock_timestamp(),
           max(finished_at) FILTER (WHERE status = 'COMPLETED'),
           max(finished_at) FILTER (WHERE readable),
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED')::int,
           count(*) FILTER (WHERE in_period AND status = 'FAILED')::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND published_count = 0)::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND published_count > 0)::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND published_count > 0 AND verdict = 'VALID')::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND published_count > 0 AND verdict = 'INVALID')::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND published_count > 0 AND verdict = 'UNVERIFIABLE')::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND published_count > 0 AND verdict IS NULL)::int,
           count(*) FILTER (WHERE in_period AND readable)::int,
           count(*) FILTER (WHERE in_period AND status = 'COMPLETED' AND retention_state IN ('PURGED', 'PARTIALLY_PURGED'))::int,
           (SELECT count(*)::int FROM generate_series(date_trunc('day', p_from AT TIME ZONE 'UTC'),
                                                      date_trunc('day', (p_to - interval '1 microsecond') AT TIME ZONE 'UTC'),
                                                      interval '1 day') g),
           count(DISTINCT date_trunc('day', finished_at AT TIME ZONE 'UTC')) FILTER (WHERE in_period AND status = 'COMPLETED')::int,
           count(DISTINCT date_trunc('day', finished_at AT TIME ZONE 'UTC')) FILTER (WHERE in_period AND readable)::int
      INTO out_row
      FROM runs;
    -- Roll back this sub-block: its subtransaction, and with it the source lock, ends here.
    RAISE EXCEPTION USING ERRCODE = 'SIRLS', MESSAGE = 'SI_READ_RELEASE';
  EXCEPTION
    WHEN SQLSTATE 'SIRLS' THEN NULL;
    WHEN lock_not_available THEN
      RAISE EXCEPTION 'SI_READ_BUSY: the source is being changed; retry' USING ERRCODE = 'lock_not_available';
  END;

  bytes := octet_length(row_to_json(out_row)::text);
  BEGIN
    UPDATE si.read_intents i SET state = 'CONSUMED', rows_returned = 1, bytes_returned = bytes
     WHERE i.intent_id = p_intent_id AND i.state = 'OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SI_READ_BUSY: the read intent is in use; retry' USING ERRCODE = 'lock_not_available';
  END;
  INSERT INTO si.reader_access_log (principal, source_id, rows_returned, bytes_returned, intent_id)
  VALUES (who, p_source_id, 1, bytes, p_intent_id);
  RETURN NEXT out_row;
END $read_source_status$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC; si_reader gains EXECUTE on the status function only.
------------------------------------------------------------------------------------------
REVOKE ALL ON TYPE si.source_status_row FROM PUBLIC;
GRANT USAGE ON TYPE si.source_status_row TO si_reader;
REVOKE ALL ON FUNCTION si.si_claim_read_intent(text, text, uuid, text, int),
                       si.si_read_source_status(text, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_read_source_status(text, uuid, timestamptz, timestamptz) TO si_reader;
