-- B-002 migration 0011 down: remove the reader source status (M4-P1). Nothing else changed in 0011.

DROP FUNCTION si.si_read_source_status(text, uuid, timestamptz, timestamptz);
DROP TYPE si.source_status_row;
DROP FUNCTION si.si_claim_read_intent(text, text, uuid, text, int);
