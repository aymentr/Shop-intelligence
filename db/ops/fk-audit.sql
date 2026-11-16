-- B-002 M4-P3.0.1-CLOSE-01: data audit of the evidence references (docs §14.9). Not a migration; changes nothing.
-- Lists every observation whose composite references do not hold — what observations_ad and observations_run would
-- reject — whatever the current state of the constraints. PASS = zero rows. A full scan of si.observations (measured:
-- 130-200 ms at 300,000 observations): run it after any privileged operation, never per read.
--   psql -X -v ON_ERROR_STOP=1 -At -f db/ops/fk-audit.sql
SELECT o.run_id, o.ordinal FROM si.observations o
    LEFT JOIN si.ads a ON a.ad_id = o.ad_id AND a.source_id = o.source_id AND a.network = o.network AND a.native_ad_id = o.native_ad_id
    LEFT JOIN si.collection_runs r ON r.run_id = o.run_id AND r.source_id = o.source_id AND r.rights_version_id = o.rights_version_id
   WHERE a.ad_id IS NULL OR r.run_id IS NULL ORDER BY 1, 2;
