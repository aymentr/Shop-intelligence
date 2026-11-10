-- B-002 migration 0006 down: remove retention enforcement and restore the 0005 evidence guard.
-- The guard body below is the 0005 text, byte for byte (CREATE OR REPLACE keeps its owner and ACL).
-- PURGED runs remain valid 0005 rows; purged evidence is not restored (it no longer exists).

DROP FUNCTION si.si_purge_due(int);
DROP FUNCTION si.si_record_purge_failure(text, text);
DROP FUNCTION si.si_retention_status();
DROP FUNCTION si.si_purge_failures(int);

DROP TRIGGER trg_runs_purge_check ON si.collection_runs;
DROP TRIGGER trg_runs_retention ON si.collection_runs;
DROP TRIGGER trg_observation_purge_check ON si.observations;
DROP TABLE si.purge_log;
DROP TABLE si.purge_failures;

DROP FUNCTION si.trg_runs_purge_check();
DROP FUNCTION si.trg_observation_purge_check();
DROP FUNCTION si.trg_purge_log_check();
DROP FUNCTION si.trg_purge_records_append_only();
DROP FUNCTION si.trg_runs_retention();
DROP FUNCTION si.si_retention_end_reason(text, int, timestamptz);
DROP FUNCTION si.si_cleanup_due_by(text, int, timestamptz);
DROP FUNCTION si.si_effective_retention_end(text, int, timestamptz);

DROP INDEX si.observations_by_ad;

CREATE OR REPLACE FUNCTION si.trg_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $evidence_guard$
BEGIN
  RAISE EXCEPTION 'SI_EVIDENCE_IMMUTABLE: evidence cannot be changed or removed' USING ERRCODE = '23514';
END $evidence_guard$;
