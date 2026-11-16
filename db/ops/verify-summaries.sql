-- B-002 M4-P3.1-CLOSE-01 (condition C3): mandatory summary verification (docs §15.8). Not a migration.
-- Recomputes every summarized run of every source from its authoritative observations (si_verify_summaries) and lists
-- every finding. PASS = zero rows. Run as si_owner, READ WRITE (a finding records DRIFT_DETECTED, which makes the source
-- ineligible for summary-backed reads; a clean verification of a source with open drift records DRIFT_CLEARED):
--   psql -X -v ON_ERROR_STOP=1 -At -c 'SET ROLE si_owner' -f db/ops/verify-summaries.sql
-- Required: at deployment verification, in DR-1 after a restore, after any privileged (owner or superuser) operation on
-- summary or evidence tables, and on a schedule. The owner is TRUSTED (contract B): eligibility (si_summary_coverage)
-- and the catalog gate cannot detect owner tampering with summary rows or drift events; only this verification does,
-- and only as of the moment it runs (time of check / time of use).
SELECT s.source_id, v.run_id, v.finding
  FROM (SELECT x.source_id FROM si.sources x ORDER BY x.source_id) s
 CROSS JOIN LATERAL si.si_verify_summaries(s.source_id) v
 ORDER BY 1, 3, 2;
