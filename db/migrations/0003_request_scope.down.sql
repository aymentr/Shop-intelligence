-- Reverses 0003. Destructive: the runner requires --allow-destructive and refuses if any
-- non-SYNTHETIC source exists. Leaves 0001 and 0002 exactly as they were.
DROP TABLE si.run_request_scope;
DROP FUNCTION si.si_begin_run_scoped(text, text, text, text, text[], text);
DROP FUNCTION si.trg_run_scope_append_only();
DROP FUNCTION si.trg_run_scope_insert();
DROP FUNCTION si.si_request_sha256_v1(text, text, text[], text);
DROP FUNCTION si.si_fixture_sha256_v1(jsonb);
DROP FUNCTION si.si_canonical_json_v1(jsonb);
