-- B-002 migration 0012 down: remove the reader source availability (M4-P1.1). Nothing else changed in 0012.

DROP FUNCTION si.si_read_source_availability(text, uuid);
DROP TYPE si.source_availability_row;
