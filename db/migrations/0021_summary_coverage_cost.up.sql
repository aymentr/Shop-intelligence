-- B-002 migration 0021: M4-P3.1-CLOSE-01 condition C1 (summary eligibility cost; synthetic only). Contract: docs
-- b002-m4-intelligence.md §15.7. Replaces exactly si_summary_coverage (0020) and adds two indexes. The eligibility
-- semantics are unchanged: a source is eligible iff no drift is open (si_summary_drift_open) and every COMPLETED
-- RETAINED/EMPTY run of the source has a run_summary_status row under the CURRENT normalizer fingerprint. Nothing is
-- cached: no table, counter or stored decision; the check stays live. Same owner, privileges (owner-only), STABLE.
--
-- 0020 evaluated si_normalizer_fingerprint() (a catalog lookup plus the ICU collation version) once PER RUN inside the
-- anti-join (about 520-690 ms at 30,000 runs, M4-P3.1-ACCEPT-01). Here it is evaluated ONCE per call, and the anti-join
-- is a merge of two index-only scans in run_id order:
--   collection_runs_summary_eligible  (source_id, run_id) WHERE status = 'COMPLETED' AND retention_state IN (RETAINED, EMPTY)
--   run_summary_status_by_source      (source_id, normalizer, run_id)
-- The status row's source_id equals its run's (composite FK run_summary_status_run), so restricting the status side to
-- the source does not change the result. The planner settings pin the merge plan (no hash of the status table, no
-- per-run nested loop) independently of statistics.

CREATE INDEX collection_runs_summary_eligible ON si.collection_runs (source_id, run_id)
  WHERE status = 'COMPLETED' AND retention_state IN ('RETAINED', 'EMPTY');
CREATE INDEX run_summary_status_by_source ON si.run_summary_status (source_id, normalizer, run_id);

CREATE OR REPLACE FUNCTION si.si_summary_coverage(p_source_id text)
RETURNS TABLE (eligible boolean, reasons text[])
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
SET enable_hashjoin = off
SET enable_nestloop = off
SET enable_sort = off
AS $summary_coverage$
DECLARE
  fp constant text := si.si_normalizer_fingerprint();                         -- once per call, not per run
  r text[];
BEGIN
  r := array_remove(ARRAY[
         CASE WHEN si.si_summary_drift_open(p_source_id) THEN 'DRIFT' END,
         CASE WHEN EXISTS (SELECT 1 FROM si.collection_runs x
                            WHERE x.source_id = p_source_id AND x.status = 'COMPLETED' AND x.retention_state IN ('RETAINED', 'EMPTY')
                              AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s
                                               WHERE s.source_id = p_source_id AND s.normalizer = fp AND s.run_id = x.run_id))
              THEN 'INCOMPLETE' END], NULL);
  RETURN QUERY SELECT cardinality(r) = 0, r;
END $summary_coverage$;
