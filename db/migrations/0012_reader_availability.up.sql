-- B-002 migration 0012: M4-P1.1 — explicit source availability for the internal reader (synthetic only).
-- Contract: docs/b002-m4-intelligence.md §D1. Migrations 0001-0011 unchanged; si_read_evidence and
-- si_read_source_status are not modified.
--
-- Why (acceptance defect D1): si_read_evidence returns an empty page for a source that is suspended, terminated,
-- retired or rights-restricted, which a history or search over that source cannot tell apart from "no evidence".
-- A granted reader has no other way to learn why, and no way to learn that a source's availability changed while
-- it read several pages. This adds ONE content-free reader function that answers, for one source and NOW:
--   - available (exactly the 0011 availability predicate, copied verbatim);
--   - the reasons it is not, as fixed codes in a fixed order:
--       RETIRED              retired, or retiring within the publish margin;
--       TERMINATED           TERMINATE_RETENTION is the latest control, or terminates the rights version in effect;
--       SUSPENDED            SUSPEND is the latest control;
--       RIGHTS_RESTRICTED    no rights version in effect, evaluation not ALLOWED, or the version's own validity
--                            (expiry or the next version) ends within the publish margin;
--       RETENTION_RESTRICTED the version in effect does not allow retention;
--       NOT_SYNTHETIC        (cannot occur: the schema allows synthetic sources only; kept so the codes cover the predicate);
--       UNAVAILABLE          the predicate is false for no reason above (fails closed; should not occur);
--   - a state token: a digest of the source row version (xmin), the latest control sequence, the latest rights
--     version and the version in effect. Controls and rights versions are append-only, and any change to the
--     source row changes its xmin, so two equal tokens mean nothing that decides availability was committed in
--     between. With equal tokens, availability is monotone in time (retirement, expiry and window ends only
--     move a source towards unavailable; a version taking effect changes the token), so "available at both ends,
--     equal tokens" means available throughout. The library uses this to refuse a multi-page scan during which
--     availability changed (AVAILABILITY_CHANGED) instead of returning a silently truncated result.
-- Nothing else is revealed: no content, no identifiers, no times other than as_of, no reason text, no counts.
--
-- It is gated exactly like the status function (0011):
--   - the same dedicated-principal, isolation and session checks (including synchronous_commit <> off);
--   - a committed, crash-durable read intent of this login, scope 'v1|<source>|availability', limit 1
--     (si_begin_read already accepts it; si_read_evidence and si_read_source_status reject it, and this
--     function accepts no other scope, so intents cannot be used for one another);
--   - the 0010 durability gate (si_claim_read_intent, 0011);
--   - under the source lock (FOR SHARE, rank 3, released before return): the active grant. An unknown source and
--     an ungranted source both get SI_READ_NOT_AUTHORIZED, before any availability fact is computed, so
--     availability reasons reach granted readers only;
--   - the intent is consumed and a completion row is written.

CREATE TYPE si.source_availability_row AS (
  source_id    text,
  as_of        timestamptz,
  available    boolean,
  reasons      text[],      -- empty when available; otherwise fixed codes in the fixed order above
  state_token  text         -- 32 hex characters; equal tokens = no availability-relevant change committed
);

CREATE FUNCTION si.si_read_source_availability(p_source_id text, p_intent_id uuid)
RETURNS SETOF si.source_availability_row
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $read_source_availability$
DECLARE
  who text := session_user;
  problem text;
  cur text;
  available boolean;
  cs record;                                  -- the source's current state (not "s": that is the predicate's table alias)
  out_row si.source_availability_row;
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
  cur := 'v1|' || p_source_id || '|availability';

  -- The committed, crash-durable request record for exactly this source and scope (0010 gate).
  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, 1);

  BEGIN
    PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id FOR SHARE;                -- rank 3
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g
                                 WHERE g.principal = who AND g.source_id = p_source_id AND g.revoked_at IS NULL
                                   AND g.purpose = 'INTERNAL_SYNTHETIC_EVALUATION') THEN
      RAISE EXCEPTION 'SI_READ_NOT_AUTHORIZED: not authorized' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- The 0011 availability predicate, verbatim.
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
    -- The reasons and the state token, in the same snapshot and under the same lock.
    SELECT src.evidence_kind, src.retired_at, src.xmin::text AS row_version, n.t,
           (SELECT c.kind FROM si.source_controls c WHERE c.source_id = src.source_id ORDER BY c.control_seq DESC LIMIT 1) AS last_kind,
           (SELECT max(c.control_seq) FROM si.source_controls c WHERE c.source_id = src.source_id) AS last_seq,
           (SELECT max(m.version) FROM si.rights_versions m WHERE m.source_id = src.source_id) AS max_version,
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
    out_row.source_id := p_source_id;
    out_row.as_of := cs.t;
    out_row.reasons := array_remove(ARRAY[
      CASE WHEN cs.retired_at IS NOT NULL AND NOT (cs.t + si.si_publish_margin() < cs.retired_at) THEN 'RETIRED' END,
      CASE WHEN cs.last_kind = 'TERMINATE_RETENTION'
                OR (cs.cur_version IS NOT NULL AND si.si_retention_terminated(p_source_id, cs.cur_version)) THEN 'TERMINATED' END,
      CASE WHEN cs.last_kind = 'SUSPEND' THEN 'SUSPENDED' END,
      CASE WHEN cs.cur_id IS NULL OR cs.cur_evaluation IS DISTINCT FROM 'ALLOWED'
                OR NOT (cs.t + si.si_publish_margin() < cs.cur_valid_until) THEN 'RIGHTS_RESTRICTED' END,
      CASE WHEN cs.cur_id IS NOT NULL AND cs.cur_retain IS DISTINCT FROM 'ALLOWED' THEN 'RETENTION_RESTRICTED' END,
      CASE WHEN cs.evidence_kind IS DISTINCT FROM 'SYNTHETIC' THEN 'NOT_SYNTHETIC' END
    ]::text[], NULL);
    IF available IS NOT TRUE AND cardinality(out_row.reasons) = 0 THEN
      out_row.reasons := ARRAY['UNAVAILABLE'];
    END IF;
    out_row.available := available IS TRUE AND cardinality(out_row.reasons) = 0;     -- fail closed on any disagreement
    out_row.state_token := left(encode(sha256(convert_to(concat_ws('|', 'v1', p_source_id, cs.row_version,
                             coalesce(cs.last_seq::text, '-'), coalesce(cs.max_version::text, '-'), coalesce(cs.cur_id::text, '-')), 'UTF8')), 'hex'), 32);
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
END $read_source_availability$;

------------------------------------------------------------------------------------------
-- Privileges. Nothing to PUBLIC; si_reader gains EXECUTE on the availability function only.
------------------------------------------------------------------------------------------
REVOKE ALL ON TYPE si.source_availability_row FROM PUBLIC;
GRANT USAGE ON TYPE si.source_availability_row TO si_reader;
REVOKE ALL ON FUNCTION si.si_read_source_availability(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION si.si_read_source_availability(text, uuid) TO si_reader;
