-- B-002 migration 0022 down: drops the foreign-key supporting index (restores the exact 0021 catalog; no data change).
DROP INDEX si.observations_by_ad_fk;
