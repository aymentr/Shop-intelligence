-- B-002 migration 0008 down: remove internal evidence retrieval. Reader roles are cluster objects
-- created by bootstrap and stay; they lose their only privilege (EXECUTE on the dropped function).

DROP FUNCTION si.si_read_evidence(text, text, int);
DROP TYPE si.evidence_read_row;
DROP TABLE si.reader_access_log;
DROP FUNCTION si.trg_reader_access_log_append_only();
DROP FUNCTION si.si_reader_session_problem();
DROP FUNCTION si.si_revoke_reader(text, text, text);
DROP FUNCTION si.si_grant_reader(text, text, text);
DROP TABLE si.reader_grants;
DROP FUNCTION si.trg_reader_grants_guard();
DROP FUNCTION si.si_reader_principal_ok(text);
