-- B-002 migration 0024 down: removes the batched summary verification (restores the exact 0023 catalog). The verification
-- records are dropped with it; the drift events they recorded stay in si.summary_events (0020), so open drift stays open.
DROP FUNCTION si.si_summary_clear_drift(text, bigint);
DROP FUNCTION si.si_summary_verification_status();
DROP FUNCTION si.si_summary_sweep_expire(interval);
DROP FUNCTION si.si_summary_sweep_record_failure(bigint, int, text, text);
DROP FUNCTION si.si_summary_sweep_batch(bigint, int, int, int, int);
DROP FUNCTION si.si_summary_sweep_start(text, interval);
DROP FUNCTION si.si_sweep_verify_run(uuid, text, int);
DROP TABLE si.summary_drift_clearances;
DROP TABLE si.summary_sweep_failures;
DROP TABLE si.summary_sweep_identities;
DROP TABLE si.summary_sweep_runs;
DROP TABLE si.summary_sweep_batches;
DROP TABLE si.summary_sweeps;
DROP FUNCTION si.trg_summary_sweep_transition();
DROP FUNCTION si.trg_sweep_records_append_only();
DROP INDEX si.advertiser_identities_sweep_order;
DROP INDEX si.collection_runs_sweep_order;
