-- B-002 migration 0019: M4-P3.0.1 — readability hardening (conditions A and B of M4-P3.0-ACCEPT-01; synthetic only).
-- Contract: docs/b002-m4-intelligence.md §14.8. Replaces exactly si_readable_runs_at (0018). Migrations 0001-0018, the
-- oracle si_evidence_readable, si_readable_runs and both reader functions are unchanged; same owner, privileges,
-- volatility (STABLE) and settings. No table, column, index or cached decision.
--
-- A: the unsupported networks are no longer the five-name literal of 0018 minus supported_networks. They are the
--    network values actually stored for the source's evidence (ads (source_id, network, ...): loose index scan) for
--    which NOT (network = ANY (supported_networks)) holds — the oracle's own test. A network added to the domain later
--    is therefore excluded unless supported, exactly as the oracle excludes it.
-- B: the single-snapshot invariant is documented in the function (STABLE) and tested under READ COMMITTED (SNAP-*).

CREATE OR REPLACE FUNCTION si.si_readable_runs_at(p_source_id text, p_from timestamptz, p_to timestamptz, p_t timestamptz) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET plan_cache_mode = force_custom_plan
AS $readable_runs_at$
-- STABLE is required for correctness, not only for planning: under READ COMMITTED a STABLE PL/pgSQL function runs
-- statements 1-4 on the snapshot of its calling statement, so the result is the readable set of ONE committed state.
-- VOLATILE would give each statement a new snapshot; a writer committing between them could yield a set that never
-- existed (e.g. statement 1 before a network was de-supported, statement 4 after a new verdict): docs §14.8, SNAP-M.
DECLARE
  tm constant timestamptz := p_t + si.si_publish_margin();
  supported text[];
  unsupported_networks text[];
  versions_bounded bigint[];                                                   -- retention end set and later than tm
  versions_unbounded bigint[];                                                 -- no retention end
  unsupported_runs uuid[];
  readable uuid[];
BEGIN
  -- 1. Source-wide conditions, once.
  SELECT s.supported_networks
    INTO supported
    FROM si.sources s
   WHERE s.source_id = p_source_id
     AND s.evidence_kind = 'SYNTHETIC'
     AND (s.retired_at IS NULL OR tm < s.retired_at)
     AND NOT si.si_source_suspended(s.source_id)
     AND EXISTS (SELECT 1 FROM si.rights_versions cur
                  WHERE cur.source_id = s.source_id AND cur.effective_from <= p_t
                    AND cur.version = (SELECT max(m.version) FROM si.rights_versions m
                                        WHERE m.source_id = s.source_id AND m.effective_from <= p_t)
                    AND cur.evaluation = 'ALLOWED' AND cur.retain = 'ALLOWED'
                    AND tm < si.si_window_end(cur.rights_version_id));
  IF NOT FOUND THEN
    RETURN '{}'::uuid[];
  END IF;
  -- 2. Per rights version of the source, once each.
  SELECT coalesce(array_agg(v.rights_version_id) FILTER (WHERE e.retention_end IS NOT NULL AND tm < e.retention_end), '{}'::bigint[]),
         coalesce(array_agg(v.rights_version_id) FILTER (WHERE e.retention_end IS NULL), '{}'::bigint[])
    INTO versions_bounded, versions_unbounded
    FROM si.rights_versions v
   CROSS JOIN LATERAL (SELECT si.si_retention_end(p_source_id, v.version) AS retention_end) e
   WHERE v.source_id = p_source_id AND NOT si.si_retention_terminated(p_source_id, v.version);
  -- 3. Runs with evidence in an unsupported network. The network values are those stored for this source's evidence
  -- (each observation's network is its ad's: composite FK observations_ad), enumerated by index (one probe per
  -- distinct value), not a fixed list; unsupported = NOT (network = ANY (supported_networks)), the oracle's test.
  SELECT coalesce(array_agg(x.net), '{}'::text[]) INTO unsupported_networks
    FROM (WITH RECURSIVE nets(net) AS (
            (SELECT a.network FROM si.ads a WHERE a.source_id = p_source_id ORDER BY a.network LIMIT 1)
            UNION ALL
            SELECT (SELECT a.network FROM si.ads a WHERE a.source_id = p_source_id AND a.network > nets.net
                     ORDER BY a.network LIMIT 1)
              FROM nets WHERE nets.net IS NOT NULL)
          SELECT n.net FROM nets n WHERE n.net IS NOT NULL AND NOT (n.net = ANY (supported))) x;
  IF cardinality(unsupported_networks) > 0 THEN
    SELECT coalesce(array_agg(DISTINCT o.run_id), '{}'::uuid[]) INTO unsupported_runs
      FROM si.ads a
      JOIN si.observations o ON o.ad_id = a.ad_id
     WHERE a.source_id = p_source_id AND a.network = ANY (unsupported_networks);
  ELSE
    unsupported_runs := '{}'::uuid[];
  END IF;
  -- 4. Run-level conditions: one scan of the source's runs.
  SELECT coalesce(array_agg(r.run_id ORDER BY r.run_id), '{}'::uuid[]) INTO readable
    FROM si.collection_runs r
   WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
     AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at < p_to))
     AND (SELECT rv.verdict FROM si.receipt_verifications rv WHERE rv.run_id = r.run_id) = 'VALID'
     AND (r.rights_version_id = ANY (versions_bounded)
          OR (r.retain_until IS NOT NULL AND r.rights_version_id = ANY (versions_unbounded)))
     AND (r.retain_until IS NULL OR tm < r.retain_until)
     AND NOT (r.run_id = ANY (unsupported_runs));
  RETURN readable;
END $readable_runs_at$;
