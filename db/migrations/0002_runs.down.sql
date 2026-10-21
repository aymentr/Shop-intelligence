-- Reverses 0002. Destructive: the runner requires --allow-destructive and refuses if any
-- non-SYNTHETIC source exists. Leaves 0001 exactly as it was.
DROP TABLE si.run_errors;
DROP TABLE si.publication_receipts;
DROP TABLE si.collection_runs;

DROP FUNCTION si.si_begin_run(text, text, text, text, text[]);
DROP FUNCTION si.trg_runs_insert();
DROP FUNCTION si.si_t1_rights_decision(text, timestamptz, text, text[]);
DROP FUNCTION si.si_run_lease();
DROP FUNCTION si.si_lock_request_key(text, text);
DROP FUNCTION si.si_request_lock_key(text, text);
DROP FUNCTION si.si_request_lock_namespace();
