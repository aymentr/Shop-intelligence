-- B-002 migration 0021 down: restores si_summary_coverage exactly as migration 0020 created it and drops the two indexes.

CREATE OR REPLACE FUNCTION si.si_summary_coverage(p_source_id text)
RETURNS TABLE (eligible boolean, reasons text[])
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $summary_coverage$
  SELECT cardinality(x.r) = 0, x.r
    FROM (SELECT array_remove(ARRAY[
            CASE WHEN si.si_summary_drift_open(p_source_id) THEN 'DRIFT' END,
            CASE WHEN EXISTS (SELECT 1 FROM si.collection_runs r
                               WHERE r.source_id = p_source_id AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY')
                                 AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s
                                                  WHERE s.run_id = r.run_id AND s.normalizer = si.si_normalizer_fingerprint()))
                 THEN 'INCOMPLETE' END], NULL) AS r) x
$summary_coverage$;
DROP INDEX si.run_summary_status_by_source;
DROP INDEX si.collection_runs_summary_eligible;
