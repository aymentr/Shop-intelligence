-- Reverses 0001. Destructive: the runner requires --allow-destructive and refuses
-- if any non-SYNTHETIC source exists. DROP is not blocked by the append-only
-- triggers (they guard DML, not DDL); dropping a table drops its triggers.
DROP TABLE si.rights_evidence;
DROP TABLE si.rights_versions;
DROP TABLE si.sources;

DROP FUNCTION si.si_record_rights_version(text, text, text, text, text, text, int, interval, text, text,
                                          timestamptz, timestamptz, text[], text[], text[], text[]);
DROP FUNCTION si.si_retention_end(text, int);
DROP FUNCTION si.rights_valid_for_publish(bigint, timestamptz);
DROP FUNCTION si.si_window_end(bigint);
DROP FUNCTION si.si_publish_margin();
DROP FUNCTION si.trg_rights_evidence_required();
DROP FUNCTION si.trg_evidence_attribution();
DROP FUNCTION si.trg_append_only();
DROP FUNCTION si.trg_rights_insert();
DROP FUNCTION si.trg_sources_retire_final();
