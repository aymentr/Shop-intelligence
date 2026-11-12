-- B-002 migration 0013: M4-P1.2 — opaque availability state (R1 of M4-P1.1-ACCEPT-01). Migrations 0001-0012
-- unchanged. Contract: docs/b002-m4-intelligence.md §2 and §10.
--
-- Defect (R1): 0012's state_token was left(sha256('v1|source|xmin|last_seq|max_version|cur_id'), 32): an unkeyed
-- digest of low-entropy internal counters. A granted reader recovered every input offline in well under a second
-- (the source row's last-update transaction id, its control and rights-version counts, and the GLOBAL
-- rights_version_id, a cross-source signal).
--
-- Correction: the token is an HMAC-SHA256 under a 256-bit random secret that only the owner can read, truncated to
-- 128 bits, over 'v2|<reader>|<source>|<row version>|<last control seq>|<version in effect>':
--   - Without the secret, the token is a pseudorandom function of its inputs: it cannot be inverted or correlated
--     offline, whatever the inputs' entropy (the security rests on the secret, not on the inputs).
--   - The reader principal is an input: two readers get unrelated tokens for the same state, so readers cannot
--     compare notes, and a token says nothing about any other source (the source id is an input too).
--   - What a reader still learns is exactly what the contract gives it: whether this source's availability state
--     changed between two of its own requests (FD21, R-25).
--   - The latest-rights-version input of 0012 is dropped: it is redundant. A new version either becomes the version
--     in effect during the scan (captured by the version-in-effect input) or makes the current version end within the
--     publish margin, which makes the source unavailable at the post-check; a version effective later than the margin
--     cannot change readability during the scan (docs §10 gives the argument and the tests).
--
-- Secret lifecycle (owner-controlled; no role but the owner can read si.availability_state_key):
--   - generated here from two gen_random_uuid() values (pg_strong_random; 244 random bits), never as a literal,
--     so it appears in no statement text, log line or error message;
--   - rotation: si.si_rotate_availability_state_key() (owner only) replaces it. Every token changes, so a scan in
--     flight across a rotation fails closed with AVAILABILITY_CHANGED;
--   - backup and restore: the row is schema data and travels with a dump (backups are as confidential as the key);
--     a restored copy keeps producing the same tokens. A restore without the row makes availability fail closed
--     (SI_READ_STATE_KEY_MISSING) until the owner runs the rotation function;
--   - down 0013 drops the key and restores 0012's function exactly.
--
-- Unchanged: si_read_source_availability's signature, gate, lock, grant check, predicate, reasons and privileges;
-- si_read_evidence, si_read_source_status, si_begin_read, si_claim_read_intent.

CREATE TABLE si.availability_state_key (
  key_id      int PRIMARY KEY CHECK (key_id = 1),
  secret      bytea NOT NULL CHECK (octet_length(secret) = 32),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON si.availability_state_key FROM PUBLIC;

INSERT INTO si.availability_state_key (key_id, secret)
VALUES (1, decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'));

-- HMAC-SHA256 (RFC 2104) with the 32-byte key, padded to the 64-byte block. SECURITY INVOKER: it runs with the
-- caller's rights, which is the owner's inside the SECURITY DEFINER availability function; nobody may execute it.
CREATE FUNCTION si.si_availability_mac(p_msg text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $availability_mac$
DECLARE
  k bytea;
  ki bytea;
  ko bytea;
  i int;
BEGIN
  SELECT x.secret INTO k FROM si.availability_state_key x WHERE x.key_id = 1;
  IF k IS NULL OR octet_length(k) <> 32 THEN
    RAISE EXCEPTION 'SI_READ_STATE_KEY_MISSING: the availability state key is not configured' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  k := k || '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  ki := k; ko := k;
  FOR i IN 0..63 LOOP
    ki := set_byte(ki, i, get_byte(k, i) # 54);    -- 0x36
    ko := set_byte(ko, i, get_byte(k, i) # 92);    -- 0x5c
  END LOOP;
  RETURN encode(sha256(ko || sha256(ki || convert_to(p_msg, 'UTF8'))), 'hex');
END $availability_mac$;

-- Owner-only rotation. Returns nothing about the key.
CREATE FUNCTION si.si_rotate_availability_state_key() RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $rotate$
  INSERT INTO si.availability_state_key (key_id, secret, created_at)
  VALUES (1, decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), clock_timestamp())
  ON CONFLICT (key_id) DO UPDATE SET secret = EXCLUDED.secret, created_at = EXCLUDED.created_at;
$rotate$;

CREATE OR REPLACE FUNCTION si.si_read_source_availability(p_source_id text, p_intent_id uuid)
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
    -- The reasons and the state inputs, in the same snapshot and under the same lock.
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
    -- Opaque state (0013): keyed, bound to the reader and the source.
    out_row.state_token := left(si.si_availability_mac(concat_ws('|', 'v2', who, p_source_id, cs.row_version,
                             coalesce(cs.last_seq::text, '-'), coalesce(cs.cur_id::text, '-'))), 32);
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
-- Privileges. Nothing to PUBLIC; no role gains anything. The key table, the MAC and the rotation are owner-only;
-- the availability function keeps its 0012 grant (EXECUTE for si_reader only).
------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION si.si_availability_mac(text), si.si_rotate_availability_state_key() FROM PUBLIC;
