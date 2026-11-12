-- B-002 migration 0014 down: remove server-side search and history (M4-P2). Nothing else changed in 0014.

DROP FUNCTION si.si_advertiser_history(text, uuid, text, text[], timestamptz, timestamptz, text, int);
DROP FUNCTION si.si_search_advertisers(text, uuid, text, text[], timestamptz, timestamptz, text, boolean, int);
DROP FUNCTION si.si_intelligence_check_args(text[], timestamptz, timestamptz);
DROP FUNCTION si.si_intelligence_iso(timestamptz);
DROP FUNCTION si.si_availability_state(text, text);
DROP FUNCTION si.si_intelligence_scope(text, text, text[]);
DROP INDEX si.observations_by_source_advertiser;
DROP FUNCTION si.si_normalize_advertiser(text);
